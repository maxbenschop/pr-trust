import { describe, expect, it } from "vitest";
import { asAuthor, COMMENT_MARKER, DEFAULT_MESSAGE, describeWaysToPass, planActions, renderMessage, runCheck, type PullRequestInfo } from "../src/action/check.ts";
import { FALLBACK_MAX_PAGES } from "../src/action/live.ts";
import { summaryMarkdown } from "../src/action/report.ts";
import { parseConfig } from "../src/engine/config.ts";
import type { GitHubClient, RestResponse } from "../src/github/client.ts";

type Call = { method: string; path: string; body?: unknown };

/** A fake GitHub: files on default branches, merge counts, permissions and existing comments. */
function fakeGitHub(world: {
  files?: Record<string, string>; // "owner/repo:path" -> text
  merged?: Record<string, number>; // "owner/repo:login" -> count
  permission?: string; // permission of the PR author
  comments?: { id: number; body: string; user: { type: string } }[];
  failGraphql?: boolean;
  unsearchable?: string[]; // repos missing from the search index
  authorPRs?: Record<string, { number: number; repo: string; mergedAt: string; updatedAt: string }[]>; // newest first
  failAuthorPRs?: boolean;
  renamed?: Record<string, string>; // old "owner/repo" -> current name
}) {
  const calls: Call[] = [];
  const graphqlCalls: string[] = [];
  const gh: GitHubClient = {
    stats: { requests: 0, cached: 0 },
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      if (world.failGraphql) throw new Error("GitHub is down");
      if (query.includes("search(")) {
        const q = variables.q as string;
        graphqlCalls.push(q);
        const repo = /repo:(\S+)/.exec(q)![1]!;
        if (world.unsearchable?.includes(repo)) return { search: { issueCount: 0 } } as T;
        const author = /author:(\S+)/.exec(q)?.[1];
        const n = author ? (world.merged?.[`${repo}:${author}`] ?? 0) : 1;
        return { search: { issueCount: n } } as T;
      }
      if (query.includes("user(login:")) {
        graphqlCalls.push(`user ${variables.login} after ${variables.after}`);
        if (world.failAuthorPRs) throw new Error("timed out");
        const prs = world.authorPRs?.[variables.login as string];
        if (!prs) return { user: null } as T;
        const offset = Number(variables.after ?? 0);
        const nodes = prs.slice(offset, offset + 100).map((p) => ({ ...p, repository: { nameWithOwner: p.repo } }));
        const hasNextPage = offset + 100 < prs.length;
        return { user: { pullRequests: { pageInfo: { hasNextPage, endCursor: String(offset + 100) }, nodes } } } as T;
      }
      const repo = `${variables.owner}/${variables.name}`;
      if (query.includes("nameWithOwner")) return { repository: { nameWithOwner: world.renamed?.[repo] ?? repo } } as T;
      const repository: Record<string, unknown> = {};
      for (const [, alias, path] of query.matchAll(/(f\d+): object\(expression: "HEAD:([^"]+)"\)/g)) {
        const text = world.files?.[`${repo}:${path}`];
        repository[alias!] = text === undefined ? null : { text };
      }
      return { repository } as T;
    },
    async rest<T>(method: string, path: string, body?: unknown): Promise<RestResponse<T>> {
      calls.push({ method, path, body });
      if (path.includes("/permission")) return { status: 200, data: { permission: world.permission ?? "read" } as T };
      if (method === "GET" && path.includes("/labels/")) return { status: 404, data: null as T };
      if (method === "GET" && path.includes("/comments")) return { status: 200, data: (world.comments ?? []) as T };
      return { status: 200, data: {} as T };
    },
  };
  const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace("/repos/me/repo", "")}`);
  return { gh, calls, writes, graphqlCalls };
}

const pr = (overrides: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  repo: "me/repo",
  number: 7,
  author: "newbie",
  authorType: "User",
  association: "NONE",
  state: "open",
  labels: [],
  changedFiles: 1,
  ...overrides,
});

const base = { trigger: { action: "opened", sender: "newbie" }, configPath: ".github/trust.yml", dryRun: false };

describe("runCheck", () => {
  it("skips collaborators with write access without reading the rules", async () => {
    const { gh, writes } = fakeGitHub({ permission: "write" });
    const result = await runCheck(gh, { ...base, pr: pr() });
    expect(result).toMatchObject({ status: "skipped", reason: "the author has write access to the repository" });
    expect(writes()).toEqual([]);
  });

  it("labels, comments and then closes an unknown author when told to close", async () => {
    const { gh, writes, calls } = fakeGitHub({
      files: { "me/repo:.github/trust.yml": "own_list: none\non_unknown: close\n" },
    });
    const result = await runCheck(gh, { ...base, pr: pr() });
    expect(result.status).toBe("unknown");
    expect(writes()).toEqual([
      "POST /labels",
      "POST /issues/7/labels",
      "POST /issues/7/comments",
      "PATCH /pulls/7",
    ]);
    const comment = calls.find((c) => c.path.endsWith("/comments") && c.method === "POST")!.body as { body: string };
    expect(comment.body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(comment.body).toContain("@newbie");
    expect(comment.body).toContain("closed automatically");
  });

  it("admits from another project's list and from merge history elsewhere", async () => {
    const config = "own_list: none\nadmit:\n  - list: friends/project\n  - merged: { repo: big/lib, min: 2 }\n";
    const vouched = fakeGitHub({
      files: { "me/repo:.github/trust.yml": config, "friends/project:.github/VOUCHED.td": "newbie\n" },
    });
    expect(await runCheck(vouched.gh, { ...base, pr: pr() })).toMatchObject({
      status: "admitted",
      rule: "vouched in friends/project",
    });

    const merged = fakeGitHub({ files: { "me/repo:.github/trust.yml": config }, merged: { "big/lib:newbie": 2 } });
    const result = await runCheck(merged.gh, { ...base, pr: pr() });
    expect(result).toMatchObject({ status: "admitted", reason: "2 merged PRs in big/lib" });
    expect(result.warnings).toContain("No trust list found in friends/project.");
  });

  describe("merged rules on a repository missing from the search index", () => {
    const config = "own_list: none\nadmit:\n  - merged: { repo: facebook/react, min: 2, within: 12mo }\n";
    const files = { "me/repo:.github/trust.yml": config };
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const merged = (number: number, repo: string, days: number) => ({ number, repo, mergedAt: daysAgo(days), updatedAt: daysAgo(days) });

    it("follows a renamed repository to its current name", async () => {
      const { gh, graphqlCalls } = fakeGitHub({
        files,
        unsearchable: ["facebook/react"],
        renamed: { "facebook/react": "react/react" },
        merged: { "react/react:newbie": 3 },
      });
      const result = await runCheck(gh, { ...base, pr: pr() });
      expect(result).toMatchObject({ status: "admitted", reason: "3 merged PRs in facebook/react" });
      expect(result.warnings).toEqual(["facebook/react is now react/react. The rule still works, but update it to the new name."]);
      expect(graphqlCalls.some((c) => c.startsWith("user "))).toBe(false);
    });

    it("counts the author's merged PRs from their own pull requests instead", async () => {
      const { gh, graphqlCalls } = fakeGitHub({
        files,
        unsearchable: ["facebook/react"],
        authorPRs: { newbie: [merged(1, "facebook/react", 10), merged(2, "other/repo", 20), merged(3, "Facebook/React", 30), merged(4, "facebook/react", 40)] },
      });
      const result = await runCheck(gh, { ...base, pr: pr() });
      expect(result).toMatchObject({ status: "admitted", reason: "2 merged PRs in facebook/react" });
      expect(result.warnings).toEqual([]);
      expect(graphqlCalls.filter((c) => c.startsWith("user "))).toEqual(["user newbie after null"]);
    });

    it("ignores merges outside the window and stops once past its start", async () => {
      const old = Array.from({ length: 300 }, (_, i) => merged(100 + i, "facebook/react", 400 + i));
      const { gh, graphqlCalls } = fakeGitHub({
        files,
        unsearchable: ["facebook/react"],
        authorPRs: { newbie: [merged(1, "facebook/react", 10), ...old] },
      });
      const result = await runCheck(gh, { ...base, pr: pr() });
      expect(result.status).toBe("unknown");
      expect(result.warnings).toEqual([]);
      expect(graphqlCalls.filter((c) => c.startsWith("user "))).toHaveLength(1);
    });

    it("stops after a few pages and warns when the answer is still open", async () => {
      const elsewhere = Array.from({ length: 1000 }, (_, i) => merged(i, "other/repo", 1 + i * 0.1));
      const { gh, graphqlCalls } = fakeGitHub({ files, unsearchable: ["facebook/react"], authorPRs: { newbie: elsewhere } });
      const result = await runCheck(gh, { ...base, pr: pr() });
      expect(result.status).toBe("unknown");
      expect(graphqlCalls.filter((c) => c.startsWith("user "))).toHaveLength(FALLBACK_MAX_PAGES);
      expect(result.warnings.join("\n")).toContain("facebook/react is not in GitHub's search index");
    });

    it("keeps the warning, and never errors, when the fallback fails", async () => {
      const { gh } = fakeGitHub({ files: { "me/repo:.github/trust.yml": `${config}on_unknown: close\n` }, unsearchable: ["facebook/react"], failAuthorPRs: true });
      const result = await runCheck(gh, { ...base, pr: pr() });
      expect(result.status).toBe("unknown");
      expect(result.warnings.join("\n")).toContain("facebook/react is not in GitHub's search index, and listing newbie's pull requests failed (timed out)");
    });

    it("does not walk the author's PRs when search can answer", async () => {
      const { gh, graphqlCalls } = fakeGitHub({ files, merged: { "facebook/react:newbie": 0 } });
      const result = await runCheck(gh, { ...base, pr: pr() });
      expect(result.status).toBe("unknown");
      expect(result.warnings).toEqual([]);
      expect(graphqlCalls.some((c) => c.startsWith("user "))).toBe(false);
    });
  });

  it("uses the denouncement in the project's own list, read from the default branch", async () => {
    const { gh, writes } = fakeGitHub({ files: { "me/repo:VOUCHED.td": "-newbie spam\n" } });
    const result = await runCheck(gh, { ...base, pr: pr() });
    expect(result.status).toBe("denounced");
    expect(result.configSource).toBe("built-in defaults");
    expect(writes()).toContain("PATCH /pulls/7"); // on_denounced defaults to close
  });

  it("does not close a PR that a maintainer reopened", async () => {
    const { gh, writes } = fakeGitHub({ files: { "me/repo:.github/trust.yml": "on_unknown: close\n" } });
    await runCheck(gh, { ...base, trigger: { action: "reopened", sender: "maintainer" }, pr: pr() });
    expect(writes()).not.toContain("PATCH /pulls/7");
  });

  it("changes nothing in a dry run", async () => {
    const { gh, writes } = fakeGitHub({ files: { "me/repo:.github/trust.yml": "on_unknown: close\n" } });
    const result = await runCheck(gh, { ...base, dryRun: true, pr: pr() });
    expect(result.actions.map((a) => a.kind)).toEqual(["add-label", "comment", "close"]);
    expect(result.applied).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("on an error, labels the PR for a maintainer and never closes it", async () => {
    const { gh, writes } = fakeGitHub({ failGraphql: true });
    const result = await runCheck(gh, { ...base, pr: pr() });
    expect(result.status).toBe("error");
    expect(result.reason).toContain("GitHub is down");
    expect(writes()).toEqual(["POST /labels", "POST /issues/7/labels"]);
  });

  it("reports a broken rules file as an error", async () => {
    const { gh } = fakeGitHub({ files: { "me/repo:.github/trust.yml": "admit: nope\n" } });
    const result = await runCheck(gh, { ...base, pr: pr() });
    expect(result.status).toBe("error");
    expect(result.reason).toContain("admit must be a list");
  });

  it("updates its own earlier comment once the author is admitted", async () => {
    const { gh, writes } = fakeGitHub({
      files: { "me/repo:VOUCHED.td": "newbie\n" },
      comments: [
        { id: 1, body: `${COMMENT_MARKER}\nfake`, user: { type: "User" } },
        { id: 2, body: `${COMMENT_MARKER}\nold message`, user: { type: "Bot" } },
      ],
    });
    await runCheck(gh, { ...base, pr: pr({ labels: ["trust: unknown"] }) });
    expect(writes()).toEqual([
      "DELETE /issues/7/labels/trust%3A%20unknown",
      "POST /labels",
      "POST /issues/7/labels",
      "PATCH /issues/comments/2",
    ]);
  });

  it("is skipped for closed PRs and bots", async () => {
    const { gh } = fakeGitHub({});
    expect((await runCheck(gh, { ...base, pr: pr({ state: "closed" }) })).status).toBe("skipped");
    expect((await runCheck(gh, { ...base, pr: pr({ author: "renovate[bot]", authorType: "Bot" }) })).status).toBe("skipped");
  });
});

describe("planActions", () => {
  it("lists the project's rules in the default comment", () => {
    const config = parseConfig("admit:\n  - list: ghostty-org/ghostty\n  - merged: { repo: self, min: 1, within: 1y }\n  - merged: { repo: rust-lang/rust, min: 3, within: 24mo }\n");
    const body = renderMessage(DEFAULT_MESSAGE, { author: "newbie", reason: "r", repo: "me/repo", closing: false, rules: describeWaysToPass(config) });
    expect(body).toContain("Contributor check: author not recognised yet");
    expect(body).toContain("> [!NOTE]\n> A maintainer will review it");
    expect(body).toContain("- are vouched for by a maintainer of this project, or");
    expect(body).toContain("- are vouched for in [ghostty-org/ghostty](https://github.com/ghostty-org/ghostty), or");
    expect(body).toContain("- have a merged pull request in this repository in the last year, or");
    expect(body).toContain("- have 3 merged pull requests in [rust-lang/rust](https://github.com/rust-lang/rust) in the last 24 months\n");
    expect(body).not.toMatch(/\{\w+\}/);
  });

  it("uses a separate default comment for denounced authors", () => {
    const body = renderMessage(DEFAULT_MESSAGE, { author: "bad", reason: "denounced in this project's own list", repo: "me/repo", closing: true, denounced: true });
    expect(body).toContain("Contributor check: not accepted");
    expect(body).toContain("> [!IMPORTANT]\n> It has been closed automatically. If you think this is a mistake");
    expect(body).not.toContain("You pass this check");
  });

  it("leaves out turned-off labels and comments", () => {
    const config = parseConfig('comment: never\nlabels: { unknown: "" }\n');
    const actions = planActions({
      decision: { status: "unknown", reason: "no rule admits this author" },
      config,
      pr: pr(),
      trigger: { action: "opened", sender: "newbie" },
      template: "",
    });
    expect(actions).toEqual([]);
  });

  it("uses a custom message with placeholders", () => {
    const actions = planActions({
      decision: { status: "unknown", reason: "no rule admits this author" },
      config: parseConfig(""),
      pr: pr(),
      trigger: { action: "opened", sender: "newbie" },
      template: "Hi {author}, see CONTRIBUTING.md in {repo}. ({reason})",
    });
    expect(actions[1]).toEqual({
      kind: "comment",
      body: `${COMMENT_MARKER}\nHi newbie, see CONTRIBUTING.md in me/repo. (no rule admits this author)\n`,
    });
  });
});

describe("summaryMarkdown", () => {
  it("describes the result for the job summary", () => {
    const text = summaryMarkdown("#7 by @newbie", {
      status: "unknown",
      reason: "no rule admits this author",
      rule: null,
      actions: [{ kind: "close" }],
      warnings: ["something odd"],
      configSource: "built-in defaults",
      applied: false,
    });
    expect(text).toContain("| Actions (dry run, not applied) | close the pull request |");
    expect(text).toContain("- something odd");
  });
});

describe("asAuthor", () => {
  const pr = {
    repo: "o/r", number: 7, author: "owner", authorType: "User", association: "OWNER",
    state: "open", labels: [], changedFiles: 1,
  };
  it("swaps in the given login as an outside contributor", () => {
    expect(asAuthor(pr, "@someone-else")).toMatchObject({ author: "someone-else", association: "NONE", authorType: "User", number: 7 });
  });
  it("rejects anything that is not a username", () => {
    expect(() => asAuthor(pr, "a b")).toThrow(/GitHub username/);
    expect(() => asAuthor(pr, "x".repeat(40))).toThrow();
  });
});
