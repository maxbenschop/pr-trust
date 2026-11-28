import { describe, expect, it } from "vitest";
import { asAuthor, COMMENT_MARKER, DEFAULT_MESSAGE, describeWaysToPass, planActions, renderMessage, runCheck, type PullRequestInfo } from "../src/action/check.ts";
import { FALLBACK_MAX_PAGES } from "../src/action/live.ts";
import { summaryMarkdown } from "../src/action/report.ts";
import { handleComment, isRuleViolation, oneLine, parseVouchCommand, type CommentEvent } from "../src/action/vouch.ts";
import { handlePush, pushTouches, type PushEvent } from "../src/action/recheck.ts";
import { NEW_VOUCH_FILE_HEADER } from "../src/engine/vouchfile.ts";
import { parseConfig } from "../src/engine/config.ts";
import { GitHubError, type GitHubClient, type RestResponse } from "../src/github/client.ts";

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
  permissions?: Record<string, string>; // per login, overriding `permission`
  users?: Record<string, string>; // existing accounts: login -> type
  pulls?: Record<number, Record<string, unknown>>;
  putStatus?: number; // every contents write fails with this status
  putMessage?: string; // ...and this message
  protectedDefault?: boolean; // writes to the default branch are refused by a ruleset
  branches?: string[]; // branches other than the default that already exist
  openPulls?: { number: number; head?: { ref: string }; labels?: { name: string }[] }[]; // newest first
  createPull?: { status: number; message: string }; // opening a pull request fails like this
  failPulls?: number[]; // reading these pull requests throws
  concurrentEdit?: string; // a line another commit adds just before our first write
  staleReads?: boolean; // GraphQL keeps returning files as they were before any write
  elsewhere?: Record<string, { mergedAt: string; mergedBy: string | null; owner: string }[]>; // login -> search results for `merged: { repo: any }`
  failSearch?: boolean; // every search throws
  created?: Record<string, string>; // login -> account creation time
  failCreated?: boolean;
  publicMembers?: string[]; // "org/login"
  failOrgs?: boolean;
}) {
  const calls: Call[] = [];
  const graphqlCalls: string[] = [];
  const files: Record<string, string> = { ...world.files };
  const before = { ...world.files };
  const shas = new Map<string, number>();
  const sha = (key: string) => `sha-${key}-${shas.get(key) ?? 0}`;
  let concurrentEdit = world.concurrentEdit;
  const branches = new Set(world.branches ?? []);
  const gh: GitHubClient = {
    stats: { requests: 0, cached: 0 },
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      if (world.failGraphql) throw new Error("GitHub is down");
      if (query.includes("search(")) {
        const q = variables.q as string;
        graphqlCalls.push(q);
        if (world.failSearch) throw new Error("search is down");
        if (q.includes("-user:")) {
          const login = /author:(\S+)/.exec(q)![1]!;
          const all = world.elsewhere?.[login] ?? [];
          const offset = Number(variables.after ?? 0);
          const nodes = all.slice(offset, offset + 100).map((m) => ({
            mergedAt: m.mergedAt,
            mergedBy: m.mergedBy ? { login: m.mergedBy } : null,
            repository: { owner: { login: m.owner } },
          }));
          const pageInfo = { hasNextPage: offset + 100 < all.length, endCursor: String(offset + 100) };
          return { search: { issueCount: all.length, pageInfo, nodes } } as T;
        }
        const repo = /repo:(\S+)/.exec(q)![1]!;
        if (world.unsearchable?.includes(repo)) return { search: { issueCount: 0 } } as T;
        const author = /author:(\S+)/.exec(q)?.[1];
        const n = author ? (world.merged?.[`${repo}:${author}`] ?? 0) : 1;
        return { search: { issueCount: n } } as T;
      }
      if (query.includes("createdAt")) {
        graphqlCalls.push(`created ${variables.login}`);
        if (world.failCreated) throw new Error("timed out");
        const created = world.created?.[variables.login as string];
        return { user: created ? { createdAt: created } : null } as T;
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
        const text = (world.staleReads ? before : files)[`${repo}:${path}`];
        repository[alias!] = text === undefined ? null : { text };
      }
      return { repository } as T;
    },
    async rest<T>(method: string, path: string, body?: unknown): Promise<RestResponse<T>> {
      calls.push({ method, path, body });
      if (path.includes("/permission")) {
        const login = decodeURIComponent(/collaborators\/([^/]+)/.exec(path)![1]!);
        return { status: 200, data: { permission: world.permissions?.[login] ?? world.permission ?? "read" } as T };
      }
      const contents = /^\/repos\/([^/]+\/[^/]+)\/contents\/([^?]+)(?:\?ref=(.+))?$/.exec(path);
      if (contents) {
        const branch = contents[3] ? decodeURIComponent(contents[3]) : (body as { branch?: string } | undefined)?.branch;
        const key = `${contents[1]}${branch ? `@${branch}` : ""}:${contents[2]!.split("/").map(decodeURIComponent).join("/")}`;
        if (method === "GET") {
          const text = files[key];
          if (text === undefined) return { status: 404, data: { message: "Not Found" } as T };
          return { status: 200, data: { type: "file", sha: sha(key), encoding: "base64", content: Buffer.from(text).toString("base64") } as T };
        }
        if (world.putStatus) return { status: world.putStatus, data: { message: world.putMessage ?? "Resource not accessible by integration" } as T };
        if (world.protectedDefault && !branch) return { status: 409, data: { message: RULE_VIOLATION } as T };
        if (concurrentEdit !== undefined) {
          files[key] = `${files[key] ?? ""}${concurrentEdit}\n`;
          shas.set(key, (shas.get(key) ?? 0) + 1);
          concurrentEdit = undefined;
        }
        const put = body as { content: string; sha?: string; message: string };
        const exists = files[key] !== undefined;
        if (exists && put.sha !== sha(key)) return { status: 409, data: { message: "is at another sha" } as T };
        if (!exists && put.sha) return { status: 409, data: { message: "file was deleted" } as T };
        files[key] = Buffer.from(put.content, "base64").toString("utf8");
        shas.set(key, (shas.get(key) ?? 0) + 1);
        return { status: exists ? 200 : 201, data: {} as T };
      }
      const member = /^\/orgs\/([^/]+)\/public_members\/([^/]+)$/.exec(path);
      if (member) {
        if (world.failOrgs) throw new GitHubError("GitHub API GET returned 502", 502);
        const key = `${member[1]}/${member[2]}`.toLowerCase();
        return { status: world.publicMembers?.some((m) => m.toLowerCase() === key) ? 204 : 404, data: null as T };
      }
      if (path.startsWith("/users/")) {
        const login = decodeURIComponent(path.slice("/users/".length));
        const found = Object.entries(world.users ?? {}).find(([l]) => l.toLowerCase() === login.toLowerCase());
        return found ? { status: 200, data: { login: found[0], type: found[1] } as T } : { status: 404, data: null as T };
      }
      if (method === "GET" && path === "/repos/me/repo") return { status: 200, data: { default_branch: "main" } as T };
      if (method === "GET" && path === "/repos/me/repo/git/ref/heads/main") return { status: 200, data: { object: { sha: "main-sha" } } as T };
      const ref = /\/git\/refs(?:\/heads\/(.+))?$/.exec(path);
      if (ref) {
        const name = ref[1] ?? (body as { ref: string }).ref.replace("refs/heads/", "");
        if (method === "DELETE") {
          branches.delete(name);
          return { status: 204, data: null as T };
        }
        if (method === "POST" && branches.has(name)) return { status: 422, data: { message: "Reference already exists" } as T };
        branches.add(name);
        for (const [key, text] of Object.entries(files)) {
          const [repo, file] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
          if (!repo.includes("@")) files[`${repo}@${name}:${file}`] = text;
        }
        return { status: method === "POST" ? 201 : 200, data: {} as T };
      }
      if (path.startsWith("/repos/me/repo/pulls?")) {
        const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
        if (method === "POST") throw new Error("unexpected");
        const head = query.get("head");
        const open = world.openPulls ?? [];
        if (head) return { status: 200, data: open.filter((p) => `me:${p.head?.ref}` === head) as T };
        const page = Number(query.get("page") ?? 1);
        const per = Number(query.get("per_page") ?? 30);
        return { status: 200, data: open.slice((page - 1) * per, page * per) as T };
      }
      if (method === "POST" && path === "/repos/me/repo/pulls") {
        if (world.createPull) return { status: world.createPull.status, data: { message: world.createPull.message } as T };
        return { status: 201, data: { number: 50 } as T };
      }
      const pull = /\/pulls\/(\d+)$/.exec(path);
      if (method === "GET" && pull && world.failPulls?.includes(Number(pull[1]))) throw new Error("GitHub API GET returned 502");
      if (method === "GET" && pull) return { status: 200, data: world.pulls?.[Number(pull[1])] as T };
      if (method === "GET" && path.includes("/labels/")) return { status: 404, data: null as T };
      if (method === "GET" && path.includes("/comments")) return { status: 200, data: (world.comments ?? []) as T };
      return { status: 200, data: {} as T };
    },
  };
  const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace("/repos/me/repo", "")}`);
  return { gh, calls, writes, graphqlCalls, files, branches };
}

/** What GitHub really answered to a Contents API write on a branch a ruleset protects. */
const RULE_VIOLATION = "Repository rule violations found\n\nChanges must be made through a pull request.\n\n2 of 2 required status checks are expected.\n\n";

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

  describe("rules about the author rather than a repository", () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const rules = (text: string) => ({ "me/repo:.github/trust.yml": `own_list: none\n${text}` });
    const anyRule = "admit:\n  - merged: { repo: any, min: 2, within: 12mo }\n";

    it("counts merges in others' repositories, leaving out self-merged ones, in one search", async () => {
      const { gh, graphqlCalls } = fakeGitHub({
        files: rules(anyRule),
        elsewhere: {
          newbie: [
            { mergedAt: daysAgo(5), mergedBy: "newbie", owner: "newbies-org" }, // merged it themselves
            { mergedAt: daysAgo(6), mergedBy: "maint", owner: "Newbie" }, // their own account's repo
            { mergedAt: daysAgo(7), mergedBy: "maint", owner: "big" },
            { mergedAt: daysAgo(8), mergedBy: null, owner: "lib" }, // merger deleted since
          ],
        },
      });
      const result = await runCheck(gh, { ...base, pr: pr() });
      expect(result).toMatchObject({ status: "admitted", rule: "≥2 merged PRs in others' public repos within 12 months", reason: "2 merged PRs in others' public repositories" });
      const searches = graphqlCalls.filter((c) => c.includes("-user:"));
      expect(searches).toHaveLength(1);
      expect(searches[0]).toMatch(/^is:pr is:merged is:public author:newbie -user:newbie merged:\S+\.\.\S+$/);
    });

    it("does not admit on self-merges alone, and reads only a few pages", async () => {
      const own = Array.from({ length: 500 }, () => ({ mergedAt: daysAgo(3), mergedBy: "newbie", owner: "newbies-org" }));
      const { gh, graphqlCalls } = fakeGitHub({ files: rules(anyRule), elsewhere: { newbie: own } });
      const result = await runCheck(gh, { ...base, pr: pr() });
      expect(result.status).toBe("unknown");
      expect(graphqlCalls.filter((c) => c.includes("-user:"))).toHaveLength(3);
      expect(result.warnings).toEqual([
        "Search found 500 pull requests by newbie merged outside their own account, more than this check reads; of the first 300, 0 were merged by someone else, so that rule did not match.",
      ]);
    });

    it("treats a failed search as no match, with a warning", async () => {
      const { gh } = fakeGitHub({ files: rules(anyRule), failSearch: true });
      const result = await runCheck(gh, { ...base, pr: pr() });
      expect(result.status).toBe("unknown");
      expect(result.warnings).toEqual([expect.stringMatching(/^Could not search newbie's merged pull requests elsewhere on GitHub \(search is down\)/)]);
    });

    it("admits public members of an organisation with one request", async () => {
      const files = rules("admit:\n  - org_member: rust-lang\n");
      const member = fakeGitHub({ files, publicMembers: ["rust-lang/newbie"] });
      expect(await runCheck(member.gh, { ...base, pr: pr() })).toMatchObject({ status: "admitted", reason: "public member of rust-lang" });
      expect(member.calls.filter((c) => c.path.includes("/public_members/")).map((c) => c.path)).toEqual(["/orgs/rust-lang/public_members/newbie"]);

      const outsider = fakeGitHub({ files });
      expect((await runCheck(outsider.gh, { ...base, pr: pr() })).status).toBe("unknown");

      const failing = fakeGitHub({ files, failOrgs: true });
      const result = await runCheck(failing.gh, { ...base, pr: pr() });
      expect(result.status).toBe("unknown");
      expect(result.warnings).toEqual([expect.stringMatching(/^Could not check whether newbie is a public member of rust-lang/)]);
    });

    describe("min_account_age", () => {
      const files = rules("min_account_age: 30d\nadmit:\n  - org_member: rust-lang\n");
      const publicMembers = ["rust-lang/newbie"];

      it("holds back an account younger than the floor that a rule would admit", async () => {
        const { gh } = fakeGitHub({ files, publicMembers, created: { newbie: daysAgo(3) } });
        const result = await runCheck(gh, { ...base, pr: pr() });
        expect(result).toMatchObject({
          status: "unknown",
          reason: "the account is 3 days old, and rules other than this project's own list need an account at least 30 days old",
        });
      });

      it("admits an old enough account, and never asks for anyone no rule admits", async () => {
        const old = fakeGitHub({ files, publicMembers, created: { newbie: daysAgo(31) } });
        expect((await runCheck(old.gh, { ...base, pr: pr() })).status).toBe("admitted");
        const nobody = fakeGitHub({ files, created: { newbie: daysAgo(3) } });
        expect((await runCheck(nobody.gh, { ...base, pr: pr() })).reason).toBe("no rule admits this author");
        expect(nobody.graphqlCalls.filter((c) => c.startsWith("created "))).toEqual([]);
      });

      it("does not hold back the project's own list", async () => {
        const { gh, graphqlCalls } = fakeGitHub({
          files: { ...rules(""), "me/repo:.github/trust.yml": "min_account_age: 30d\n", "me/repo:.github/VOUCHED.td": "newbie\n" },
          created: { newbie: daysAgo(1) },
        });
        expect(await runCheck(gh, { ...base, pr: pr() })).toMatchObject({ status: "admitted", rule: "own list" });
        expect(graphqlCalls.filter((c) => c.startsWith("created "))).toEqual([]);
      });

      it("treats an unreadable creation date as too new, with a warning", async () => {
        const { gh } = fakeGitHub({ files, publicMembers, failCreated: true });
        const result = await runCheck(gh, { ...base, pr: pr() });
        expect(result.status).toBe("unknown");
        expect(result.reason).toMatch(/^the account's age could not be confirmed/);
        expect(result.warnings).toEqual([expect.stringMatching(/^Could not read when newbie's account was created/)]);
      });
    });
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

  it("describes merges elsewhere, organisation membership and the account age floor", () => {
    const config = parseConfig(
      "min_account_age: 30d\nadmit:\n  - merged: { repo: any, min: 3, within: 24mo }\n  - org_member: rust-lang\n",
    );
    expect(describeWaysToPass(config)).toBe(
      "- are vouched for by a maintainer of this project, or\n" +
        "- have 3 merged pull requests in the last 24 months in public repositories you do not own, merged by someone else, or\n" +
        "- are a public member of the [rust-lang](https://github.com/orgs/rust-lang/people) organisation (members can make their membership public on that page)\n\n" +
        "Apart from a maintainer's vouch, these only count for accounts at least 30 days old.",
    );
    const noOwnList = parseConfig("own_list: none\nmin_account_age: 1y\nadmit:\n  - org_member: rust-lang\n");
    expect(describeWaysToPass(noOwnList)).toMatch(/\n\nThese only count for accounts at least 1 year old\.$/);
    // Nothing for the floor to act on: it is not mentioned.
    expect(describeWaysToPass(parseConfig("min_account_age: 30d\n"))).toBe("- are vouched for by a maintainer of this project");
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

describe("parseVouchCommand", () => {
  it("accepts /vouch, /vouch @login and /vouch login on the first line", () => {
    expect(parseVouchCommand("/vouch")).toEqual({ kind: "vouch", target: null });
    expect(parseVouchCommand("  /vouch  \r\nthanks for the fix")).toEqual({ kind: "vouch", target: null });
    expect(parseVouchCommand("/vouch @Octo-Cat")).toEqual({ kind: "vouch", target: "Octo-Cat" });
    expect(parseVouchCommand("/vouch\toctocat\n\nmore text")).toEqual({ kind: "vouch", target: "octocat" });
  });

  it("ignores everything else", () => {
    for (const body of [
      "", "vouch", "/Vouch", "/vouched", "/vouch@octocat", "lgtm\n/vouch", "\n/vouch",
      "> /vouch", "`/vouch`", "please /vouch", undefined, null, 42,
    ]) {
      expect(parseVouchCommand(body)).toBeNull();
    }
  });

  it("marks /vouch followed by anything but one username as invalid", () => {
    for (const body of [
      "/vouch @", "/vouch @@octocat", "/vouch octocat please", "/vouch @a @b", "/vouch -octocat",
      "/vouch ../../etc", "/vouch a/b", "/vouch $(rm -rf /)", "/vouch renovate[bot]", `/vouch ${"x".repeat(40)}`,
    ]) {
      expect(parseVouchCommand(body)).toEqual({ kind: "invalid" });
    }
  });
});

describe("handleComment", () => {
  const event = (overrides: Partial<CommentEvent> & { body?: string; by?: string; on?: "pr" | "issue" } = {}): CommentEvent => {
    const by = overrides.by ?? "maint";
    return {
      action: "created",
      comment: { id: 99, body: overrides.body ?? "/vouch", user: { login: by, type: "User" } },
      issue: { number: 7, user: { login: "newbie", type: "User" }, ...(overrides.on === "issue" ? {} : { pull_request: {} }) },
      sender: { login: by, type: "User" },
      ...overrides,
    };
  };
  const world = (extra: Parameters<typeof fakeGitHub>[0] = {}) =>
    fakeGitHub({
      permissions: { maint: "maintain" },
      users: { NewBie: "User", maint: "User", "some-org": "Organization" },
      pulls: { 7: { number: 7, state: "open", user: { login: "newbie", type: "User" }, author_association: "NONE", labels: [{ name: "trust: unknown" }], changed_files: 1 } },
      ...extra,
      files: { "me/repo:.github/trust.yml": "own_list: auto\n", ...extra.files },
    });
  const run = (gh: ReturnType<typeof fakeGitHub>["gh"], e: CommentEvent, dryRun = false) =>
    handleComment(gh, { repo: "me/repo", event: e, configPath: ".github/trust.yml", dryRun });
  const replies = (calls: Call[]) =>
    calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues/7/comments")).map((c) => (c.body as { body: string }).body);

  it("ignores ordinary comments without a single API call", async () => {
    const { gh, calls, graphqlCalls } = world();
    for (const body of ["Looks good!", "lgtm", "/vouchsafe", "> /vouch"]) {
      expect(await run(gh, event({ body }))).toMatchObject({ outcome: "ignored", reason: "not a /vouch command" });
    }
    expect(await run(gh, event({ action: "edited" }))).toMatchObject({ outcome: "ignored" });
    expect(calls).toEqual([]);
    expect(graphqlCalls).toEqual([]);
  });

  it("ignores bots and people without write access, silently and without writing", async () => {
    const { gh, calls, writes } = world({ permissions: { maint: "maintain", helper: "triage", reader: "read" } });
    const bot = { login: "github-actions[bot]", type: "Bot" };
    expect(await run(gh, event({ comment: { id: 99, body: "/vouch", user: bot }, sender: bot }))).toMatchObject({ outcome: "ignored" });
    expect(calls).toEqual([]); // decided before asking GitHub anything
    for (const by of ["helper", "reader", "newbie"]) {
      expect(await run(gh, event({ by, body: "/vouch @newbie" }))).toMatchObject({ outcome: "ignored", reason: `@${by} does not have write access to me/repo` });
    }
    // An OWNER association in the payload counts for nothing; only the permission API does.
    const spoof = event({ by: "reader" });
    expect(await run(gh, { ...spoof, comment: { ...spoof.comment, author_association: "OWNER" } as CommentEvent["comment"] })).toMatchObject({ outcome: "ignored" });
    expect(writes()).toEqual([]);
  });

  it("adds the PR author to a new .github/VOUCHED.td, reacts, and checks the PR again", async () => {
    // staleReads: reading the list back would still find nothing, so the re-check must use the new text.
    const { gh, calls, writes, files } = world({ staleReads: true });
    const result = await run(gh, event());
    expect(result.outcome).toBe("vouched");
    expect(files["me/repo:.github/VOUCHED.td"]).toBe(`${NEW_VOUCH_FILE_HEADER}newbie\n`);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/repos/me/repo/contents/.github/VOUCHED.td");
    expect((put.body as { message: string; sha?: string }).message).toBe("Vouch for @NewBie\n\n@maint vouched for @NewBie with /vouch in #7.\n");
    expect((put.body as { sha?: string }).sha).toBeUndefined();
    expect(result.check).toMatchObject({ status: "admitted", reason: "vouched in this project's own list" });
    expect(writes()).toEqual([
      "PUT /contents/.github/VOUCHED.td",
      "POST /issues/comments/99/reactions",
      "DELETE /issues/7/labels/trust%3A%20unknown",
      "POST /labels",
      "POST /issues/7/labels",
    ]);
    expect(replies(calls)).toEqual([]);
  });

  it("vouches a named account into the existing list where own_list points", async () => {
    const { gh, calls, files } = world({
      users: { Octocat: "User" },
      files: { "me/repo:.github/trust.yml": "own_list: docs/TRUST.td\n", "me/repo:docs/TRUST.td": "# ours\nalice\nzed\n" },
    });
    const result = await run(gh, event({ body: "/vouch @octocat", on: "issue" }));
    expect(result).toMatchObject({ outcome: "vouched", check: null });
    expect(files["me/repo:docs/TRUST.td"]).toBe("# ours\nalice\noctocat\nzed\n");
    expect((calls.find((c) => c.method === "PUT")!.body as { sha?: string }).sha).toBe("sha-me/repo:docs/TRUST.td-0");
    expect(calls.some((c) => c.path.includes("/pulls/"))).toBe(false); // an issue: nothing to re-check
  });

  it("does not write when the account is already vouched, but still re-checks the PR", async () => {
    const { gh, writes } = world({ files: { "me/repo:VOUCHED.td": "github:newbie\n" } });
    const result = await run(gh, event());
    expect(result).toMatchObject({ outcome: "already-vouched", reason: expect.stringContaining("already vouched for in VOUCHED.td") });
    expect(result.check?.status).toBe("admitted");
    expect(writes().filter((w) => w.startsWith("PUT"))).toEqual([]);
    expect(writes()[0]).toBe("POST /issues/comments/99/reactions");
  });

  it("refuses to overturn a denouncement", async () => {
    const { gh, calls, writes } = world({ files: { "me/repo:.github/VOUCHED.td": "-newbie spam\n" } });
    const result = await run(gh, event());
    expect(result.outcome).toBe("refused");
    expect(writes()).toEqual(["POST /issues/7/comments"]);
    expect(replies(calls)[0]).toContain("`NewBie` is denounced in `.github/VOUCHED.td`");
  });

  it("replies instead of writing for own_list: none, unknown accounts, organisations and bad usernames", async () => {
    const cases: [Parameters<typeof fakeGitHub>[0], CommentEvent, string][] = [
      [{ files: { "me/repo:.github/trust.yml": "own_list: none\n" } }, event(), "`own_list: none`"],
      [{}, event({ body: "/vouch @ghost-user" }), "There is no GitHub account named `ghost-user`"],
      [{}, event({ body: "/vouch some-org" }), "not a personal account (it is a organization)"],
      [{}, event({ body: "/vouch @a b" }), "`/vouch` takes one GitHub username"],
      [{}, event({ on: "issue" }), "On an issue, name the account"],
    ];
    for (const [extra, e, text] of cases) {
      const { gh, calls, writes } = world(extra);
      expect((await run(gh, e)).outcome).toBe("refused");
      expect(writes()).toEqual(["POST /issues/7/comments"]);
      expect(replies(calls)[0]).toContain(text);
      expect(replies(calls)[0]!.startsWith("@maint ")).toBe(true);
    }
  });

  it("retries once on a fresh read when another commit changed the list meanwhile", async () => {
    const { gh, calls, files } = world({ files: { "me/repo:.github/VOUCHED.td": "alice\n" }, concurrentEdit: "zed" });
    const result = await run(gh, event());
    expect(result.outcome).toBe("vouched");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    expect(files["me/repo:.github/VOUCHED.td"]).toBe("alice\nnewbie\nzed\n");
    expect(result.check?.status).toBe("admitted");
  });

  it("explains what to do when it cannot write, and never touches the PR", async () => {
    const { gh, calls, writes } = world({ putStatus: 403 });
    const result = await run(gh, event());
    expect(result.outcome).toBe("failed");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1); // no retry for a missing permission
    expect(writes()).toEqual(["PUT /contents/.github/VOUCHED.td", "POST /issues/7/comments"]);
    expect(replies(calls)[0]).toContain("`permissions: contents: write`");
    expect(replies(calls)[0]).toContain("add the line `newbie` to `.github/VOUCHED.td`");

    const conflict = world({ putStatus: 409, putMessage: "is at 1234 but expected 5678" });
    expect((await run(conflict.gh, event())).outcome).toBe("failed");
    expect(conflict.calls.filter((c) => c.method === "PUT")).toHaveLength(2); // a real conflict: one retry
    expect(conflict.calls.some((c) => c.path.includes("/git/") || c.path.includes("/pulls"))).toBe(false);
    expect(replies(conflict.calls)[0]).toContain("The list kept changing");
  });

  it("suggests the exact line it would have added, in one paragraph", async () => {
    const { gh, calls } = world({
      putStatus: 403,
      putMessage: "Resource not accessible\n\nby integration",
      files: { "me/repo:.github/VOUCHED.td": "github:alice\ngithub:zed\n" },
    });
    expect((await run(gh, event())).outcome).toBe("failed");
    const text = replies(calls)[0]!;
    expect(text).toContain("add the line `github:newbie` to `.github/VOUCHED.td`");
    expect(text).toContain("(GitHub said: 403 Resource not accessible. by integration)");
    expect(text).not.toContain("\n");
  });

  describe("on a default branch that only takes pull requests", () => {
    const protectedWorld = (extra: Parameters<typeof fakeGitHub>[0] = {}) =>
      world({ protectedDefault: true, ...extra, files: { "me/repo:.github/VOUCHED.td": "github:alice\ngithub:zed\n", ...extra.files } });

    it("opens a pull request with the one-line change instead, without a pointless retry", async () => {
      const { gh, calls, writes, files, branches } = protectedWorld();
      const result = await run(gh, event());
      expect(result).toMatchObject({ outcome: "proposed", check: null });
      expect(result.reason).toContain("opened pull request #50");
      expect(writes()).toEqual([
        "PUT /contents/.github/VOUCHED.td", // refused once, not retried
        "POST /git/refs",
        "PUT /contents/.github/VOUCHED.td",
        "POST /pulls",
        "POST /issues/7/comments",
      ]);
      const [, ref, put, pull] = calls.filter((c) => c.method !== "GET");
      expect(ref!.body).toEqual({ ref: "refs/heads/pr-trust/vouch-newbie", sha: "main-sha" });
      expect((put!.body as { branch?: string }).branch).toBe("pr-trust/vouch-newbie");
      expect(files["me/repo:.github/VOUCHED.td"]).toBe("github:alice\ngithub:zed\n"); // default branch untouched
      expect(files["me/repo@pr-trust/vouch-newbie:.github/VOUCHED.td"]).toBe("github:alice\ngithub:newbie\ngithub:zed\n");
      expect(branches.has("pr-trust/vouch-newbie")).toBe(true);
      const body = pull!.body as { title: string; head: string; base: string; body: string };
      expect(body).toMatchObject({ title: "Vouch for @NewBie", head: "pr-trust/vouch-newbie", base: "main" });
      expect(body.body).toContain("@maint asked for this with `/vouch` in #7");
      expect(body.body).toContain("does not start other workflows");
      expect(replies(calls)).toEqual([
        "@maint The default branch only takes changes through pull requests, so I opened #50 to add `github:newbie` to `.github/VOUCHED.td`. Merge it to finish.",
      ]);
    });

    it("links the pull request already open for the same account instead of opening another", async () => {
      const { gh, calls, writes } = protectedWorld({ openPulls: [{ number: 42, head: { ref: "pr-trust/vouch-newbie" } }] });
      const result = await run(gh, event());
      expect(result.outcome).toBe("proposed");
      expect(writes()).toEqual(["PUT /contents/.github/VOUCHED.td", "POST /issues/7/comments"]);
      expect(replies(calls)[0]).toContain("#42 to vouch for `NewBie` is already open. Merge it to finish.");
    });

    it("reuses a branch left over from an earlier proposal", async () => {
      const { gh, writes, branches } = protectedWorld({ branches: ["pr-trust/vouch-newbie"] });
      expect((await run(gh, event())).outcome).toBe("proposed");
      expect(writes()).toEqual([
        "PUT /contents/.github/VOUCHED.td",
        "POST /git/refs",
        "PATCH /git/refs/heads/pr-trust/vouch-newbie",
        "PUT /contents/.github/VOUCHED.td",
        "POST /pulls",
        "POST /issues/7/comments",
      ]);
      expect(branches.has("pr-trust/vouch-newbie")).toBe(true);
    });

    it("deletes its branch and explains the setting when it may not open pull requests", async () => {
      const { gh, calls, writes, branches } = protectedWorld({
        createPull: { status: 403, message: "GitHub Actions is not permitted to create or approve pull requests." },
      });
      const result = await run(gh, event());
      expect(result.outcome).toBe("failed");
      expect(writes()).toEqual([
        "PUT /contents/.github/VOUCHED.td",
        "POST /git/refs",
        "PUT /contents/.github/VOUCHED.td",
        "POST /pulls",
        "DELETE /git/refs/heads/pr-trust/vouch-newbie",
        "POST /issues/7/comments",
      ]);
      expect(branches.has("pr-trust/vouch-newbie")).toBe(false);
      const text = replies(calls)[0]!;
      expect(text).not.toContain("\n");
      expect(text).toContain("(GitHub said: 403 GitHub Actions is not permitted to create or approve pull requests.)");
      expect(text).toContain('"Allow GitHub Actions to create and approve pull requests"');
      expect(text).toContain("add the line `github:newbie` to `.github/VOUCHED.td` in a pull request yourself");
      // The pull request the command was posted on is never changed.
      expect(calls.some((c) => c.method !== "GET" && (c.path.includes("/pulls/7") || c.path.includes("/issues/7/labels")))).toBe(false);
    });
  });

  it("tells rule violations apart from conflicts and flattens GitHub's messages", () => {
    const err = (status: number, message: string) => new GitHubError(`${status} ${oneLine(message)}`, status);
    expect(isRuleViolation(err(409, RULE_VIOLATION))).toBe(true);
    expect(isRuleViolation(err(409, "Changes must be made through a pull request."))).toBe(true);
    expect(isRuleViolation(err(422, "Protected branch update failed for refs/heads/main."))).toBe(true);
    expect(isRuleViolation(err(409, "is at 1234 but expected 5678"))).toBe(false);
    expect(isRuleViolation(err(403, "Resource not accessible by integration"))).toBe(false);
    expect(isRuleViolation(err(404, "Changes must be made through a pull request."))).toBe(false);
    expect(oneLine(RULE_VIOLATION)).toBe("Repository rule violations found. Changes must be made through a pull request. 2 of 2 required status checks are expected.");
    expect(oneLine("a `b`\nc")).toBe("a 'b'. c");
  });

  it("writes nothing in a dry run", async () => {
    const { gh, writes } = world();
    const result = await run(gh, event(), true);
    expect(result).toMatchObject({ outcome: "vouched", reason: expect.stringContaining("would add NewBie") });
    expect(result.check?.status).toBe("admitted");
    expect(writes()).toEqual([]);
  });
});

describe("handlePush", () => {
  const pull = (number: number, author: string, labels: string[] = ["trust: unknown"]) => ({
    number, state: "open", user: { login: author, type: "User" }, author_association: "NONE",
    labels: labels.map((name) => ({ name })), changed_files: 1,
  });
  const pulls = [pull(9, "newbie"), pull(8, "stranger"), pull(6, "other", ["trust: admitted"]), pull(5, "newbie-two")];
  const world = (extra: Parameters<typeof fakeGitHub>[0] = {}) =>
    fakeGitHub({
      openPulls: pulls,
      pulls: Object.fromEntries(pulls.map((p) => [p.number, p])),
      ...extra,
      files: {
        "me/repo:.github/trust.yml": "own_list: auto\non_unknown: close\n",
        "me/repo:.github/VOUCHED.td": "alice\nnewbie\nnewbie-two\n",
        ...extra.files,
      },
    });
  const push = (overrides: Partial<PushEvent> = {}): PushEvent => ({
    ref: "refs/heads/main",
    repository: { default_branch: "main" },
    commits: [{ added: [], modified: [".github/VOUCHED.td"], removed: [] }],
    sender: { login: "maint" },
    ...overrides,
  });
  const run = (gh: GitHubClient, e: PushEvent, max?: number) =>
    handlePush(gh, { repo: "me/repo", event: e, configPath: ".github/trust.yml", dryRun: false, max });

  it("checks open pull requests labelled unknown again, updating only those now admitted", async () => {
    const { gh, calls, writes } = world();
    const result = await run(gh, push());
    expect(result.outcome).toBe("rechecked");
    expect(result.checks.map((c) => [c.number, c.result.status])).toEqual([[9, "admitted"], [8, "unknown"], [5, "admitted"]]);
    expect(result.reason).toContain("checked 3 pull requests");
    expect(result.reason).toContain("2 now admitted");
    expect(calls.some((c) => c.path.endsWith("/pulls/6"))).toBe(false); // not labelled unknown
    expect(writes()).toEqual([
      "DELETE /issues/9/labels/trust%3A%20unknown", "POST /labels", "POST /issues/9/labels",
      "DELETE /issues/5/labels/trust%3A%20unknown", "POST /labels", "POST /issues/5/labels",
    ]);
    // The one still unknown is left alone: on_unknown is close, yet nothing is written to #8.
    expect(writes().some((w) => w.includes("/8"))).toBe(false);
  });

  it("checks at most the newest few and warns about the rest", async () => {
    const { gh } = world();
    const result = await run(gh, push(), 2);
    expect(result.checks.map((c) => c.number)).toEqual([9, 8]);
    expect(result.warnings).toContain('More than 2 open pull requests are labelled "trust: unknown"; only the newest 2 were checked again.');
  });

  it("keeps going when one pull request cannot be checked", async () => {
    const { gh, writes } = world({ failPulls: [9] });
    const result = await run(gh, push());
    expect(result.failed).toEqual([{ number: 9, error: "GitHub API GET returned 502" }]);
    expect(result.checks.map((c) => c.number)).toEqual([8, 5]);
    expect(writes()).toContain("POST /issues/5/labels");
    expect(result.reason).toContain("1 failed");
  });

  it("does nothing when the push did not change the list, or was not to the default branch", async () => {
    for (const e of [
      push({ commits: [{ modified: ["README.md"] }, { added: ["docs/VOUCHED.td"] }] }),
      push({ ref: "refs/heads/feature" }),
      push({ deleted: true }),
    ]) {
      const { gh, calls } = world();
      expect((await run(gh, e)).outcome).toBe("ignored");
      expect(calls.filter((c) => c.path.includes("/pulls"))).toEqual([]);
    }
  });

  it("does nothing without an own list or an unknown label", async () => {
    for (const config of ["own_list: none\n", 'labels: { unknown: "" }\n']) {
      const { gh, calls } = world({ files: { "me/repo:.github/trust.yml": config } });
      expect((await run(gh, push())).outcome).toBe("ignored");
      expect(calls).toEqual([]);
    }
  });

  it("watches the configured list path, and assumes a change when the commits are not all listed", () => {
    expect(pushTouches(push(), ["docs/TRUST.td"])).toBe(false);
    expect(pushTouches(push({ commits: [{ removed: ["docs/TRUST.td"] }] }), ["docs/TRUST.td"])).toBe(true);
    expect(pushTouches(push({ commits: undefined }), ["docs/TRUST.td"])).toBe(true);
    expect(pushTouches(push({ commits: [] }), ["docs/TRUST.td"])).toBe(true);
    expect(pushTouches(push({ size: 30, commits: [{ modified: ["README.md"] }] }), ["docs/TRUST.td"])).toBe(true);
  });
});
