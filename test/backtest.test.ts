import { describe, expect, it } from "vitest";
import { historicalSources, ListHistory, MergeIndex } from "../src/backtest/history.ts";
import { loadAuthorFacts } from "../src/backtest/load.ts";
import { groupOf, outcomeOf, replay } from "../src/backtest/replay.ts";
import { renderSummary, summarize } from "../src/backtest/report.ts";
import { parseConfig } from "../src/engine/config.ts";
import type { GitHubClient, RestResponse } from "../src/github/client.ts";
import type { PullRequestRow } from "../src/github/queries.ts";

const pr = (overrides: Partial<PullRequestRow>): PullRequestRow => ({
  number: 1,
  createdAt: "2026-03-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  state: "OPEN",
  author: "someone",
  authorType: "User",
  association: "NONE",
  closedBy: null,
  closedByType: null,
  changedFiles: 1,
  files: null,
  ...overrides,
});

describe("ListHistory", () => {
  const history = new ListHistory(".github/VOUCHED.td", [
    { at: "2026-02-01T00:00:00Z", text: "alice\n" },
    { at: "2026-01-01T00:00:00Z", text: "# new file\n" },
    { at: "2026-03-01T00:00:00Z", text: "alice\n-bob\n" },
    { at: "2026-04-01T00:00:00Z", text: null },
  ]);

  it("answers with the list as it stood at the time", () => {
    expect(history.at(new Date("2025-12-31T00:00:00Z"))).toBeNull();
    expect(history.status("alice", new Date("2026-01-15T00:00:00Z"))).toBe("unknown");
    expect(history.status("ALICE", new Date("2026-02-01T00:00:00Z"))).toBe("vouched");
    expect(history.status("bob", new Date("2026-03-02T00:00:00Z"))).toBe("denounced");
    expect(history.status("alice", new Date("2026-05-01T00:00:00Z"))).toBe("unknown");
  });
});

describe("MergeIndex", () => {
  it("counts merges in a half-open window", () => {
    const index = new MergeIndex([
      { author: "Alice", mergedAt: "2026-01-01T00:00:00Z", mergedBy: null },
      { author: "alice", mergedAt: "2026-02-01T00:00:00Z", mergedBy: null },
      { author: "bob", mergedAt: "2026-02-01T00:00:00Z", mergedBy: null },
    ]);
    const d = (s: string) => new Date(s);
    expect(index.count("alice", d("2026-01-01T00:00:00Z"), d("2026-02-01T00:00:00Z"))).toBe(1);
    expect(index.count("alice", d("2025-01-01T00:00:00Z"), d("2027-01-01T00:00:00Z"))).toBe(2);
    expect(index.count("carol", d("2025-01-01T00:00:00Z"), d("2027-01-01T00:00:00Z"))).toBe(0);
  });
});

describe("classification", () => {
  it("groups authors", () => {
    expect(groupOf(pr({ author: null }))).toBe("deleted");
    expect(groupOf(pr({ author: "dependabot", authorType: "Bot" }))).toBe("bot");
    expect(groupOf(pr({ author: "renovate[bot]" }))).toBe("bot");
    expect(groupOf(pr({ author: "zaniebot" }))).toBe("bot");
    expect(groupOf(pr({ association: "COLLABORATOR" }))).toBe("maintainer");
    expect(groupOf(pr({ association: "FIRST_TIME_CONTRIBUTOR" }))).toBe("external");
    // Private org members look like CONTRIBUTOR from outside; seen merging, they count as maintainers.
    expect(groupOf(pr({ author: "Hidden", association: "CONTRIBUTOR" }), new Set(["hidden"]))).toBe("maintainer");
  });

  it("tells apart who closed a PR", () => {
    expect(outcomeOf(pr({ mergedAt: "2026-03-02T00:00:00Z", state: "MERGED" }))).toBe("merged");
    expect(outcomeOf(pr({}))).toBe("open");
    expect(outcomeOf(pr({ state: "CLOSED", closedBy: "github-actions", closedByType: "Bot" }))).toBe("auto_closed");
    expect(outcomeOf(pr({ state: "CLOSED", closedBy: "Someone" }))).toBe("withdrawn");
    expect(outcomeOf(pr({ state: "CLOSED", closedBy: "maintainer" }))).toBe("rejected");
  });
});

describe("replay and summary", async () => {
  const config = parseConfig("own_list: none\nadmit:\n  - merged: { repo: self, min: 1, within: 12mo }\n");
  const merges = new MergeIndex([
    { author: "regular", mergedAt: "2025-12-01T00:00:00Z", mergedBy: null },
    { author: "newbie", mergedAt: "2026-03-05T00:00:00Z", mergedBy: null },
  ]);
  const sources = historicalSources({ own: null, lists: new Map(), merges: new Map([["me/repo", merges]]) });
  const prs = [
    pr({ number: 1, author: "regular", state: "MERGED", mergedAt: "2026-03-02T00:00:00Z" }),
    pr({ number: 2, author: "regular", state: "CLOSED", closedBy: "maint" }),
    pr({ number: 3, author: "newbie", createdAt: "2026-03-01T00:00:00Z", state: "MERGED", mergedAt: "2026-03-05T00:00:00Z" }),
    pr({ number: 4, author: "newbie", createdAt: "2026-04-01T00:00:00Z", state: "MERGED", mergedAt: "2026-04-02T00:00:00Z" }),
    pr({ number: 5, author: "spammer", state: "CLOSED", closedBy: "maint" }),
    pr({ number: 6, author: "spammer", state: "CLOSED", closedBy: "stale", closedByType: "Bot" }),
    pr({ number: 7, author: "boss", association: "OWNER" }),
  ];
  const rows = await replay(prs, config, sources, "me/repo");
  const summary = summarize({
    repo: "me/repo",
    from: new Date("2025-11-27T00:00:00Z"),
    to: new Date("2026-11-27T00:00:00Z"),
    config,
    ownListPath: null,
    rows,
    notes: [],
  });

  it("decides each external PR from history before it was opened", () => {
    expect(rows.map((r) => r.decision?.status ?? r.group)).toEqual([
      "admitted",
      "admitted",
      "unknown", // newbie's first merge comes after this PR was opened
      "admitted",
      "unknown",
      "unknown",
      "maintainer",
    ]);
  });

  it("computes the headline numbers", () => {
    expect(summary.totals).toMatchObject({ prs: 7, maintainer: 1, external: 6, externalAuthors: 3 });
    expect(summary.keeps).toEqual({ part: 2, whole: 3, value: 2 / 3 });
    expect(summary.stops).toEqual({ part: 1, whole: 2, value: 0.5 });
    expect(summary.mergeRate.blocked).toEqual({ part: 1, whole: 2, value: 0.5 });
    expect(summary.newcomers).toEqual({ blockedOnFirstPr: 2, laterMerged: 1 });
    expect(summary.blockedButMerged).toEqual([{ login: "newbie", merged: 1 }]);
    expect(summary.byDecision.unknown.autoClosed).toBe(1);
  });

  it("renders a readable report", () => {
    const text = renderSummary(summary);
    expect(text).toContain("Keeps 67% (2 of 3) of merged external PRs.");
    expect(text).toContain("1 merged PR from 1 author would have been blocked.");
    expect(text).toContain("Most affected: newbie (1)");
  });
});

describe("rules about the author, replayed", () => {
  const config = parseConfig(`own_list: none
min_account_age: 30d
admit:
  - merged: { repo: any, min: 2, within: 12mo }
  - org_member: rust-lang
`);
  const requests: string[] = [];
  const gh: GitHubClient = {
    stats: { requests: 0, cached: 0 },
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      if (query.includes("search(")) {
        const q = variables.q as string;
        requests.push(q.replace(/ merged:.*/, ""));
        const login = /author:(\S+)/.exec(q)![1]!;
        const all: Record<string, { mergedAt: string; mergedBy: { login: string } | null; repository: { owner: { login: string } } }[]> = {
          veteran: [
            { mergedAt: "2024-06-01T00:00:00Z", mergedBy: { login: "m" }, repository: { owner: { login: "big" } } }, // outside every window
            { mergedAt: "2026-02-01T00:00:00Z", mergedBy: { login: "m" }, repository: { owner: { login: "lib" } } },
            { mergedAt: "2026-02-02T00:00:00Z", mergedBy: { login: "veteran" }, repository: { owner: { login: "vets-org" } } },
            { mergedAt: "2026-02-15T00:00:00Z", mergedBy: { login: "m" }, repository: { owner: { login: "lib" } } },
          ],
          fresh: [
            { mergedAt: "2026-02-10T00:00:00Z", mergedBy: { login: "m" }, repository: { owner: { login: "big" } } },
            { mergedAt: "2026-02-11T00:00:00Z", mergedBy: { login: "m" }, repository: { owner: { login: "lib" } } },
          ],
        };
        const nodes = all[login] ?? [];
        return { search: { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } as T;
      }
      requests.push("created");
      const users: Record<string, string> = { veteran: "2015-01-01T00:00:00Z", fresh: "2026-02-01T00:00:00Z", member: "2020-01-01T00:00:00Z" };
      const logins = [...query.matchAll(/(u\d+): user\(login: "([^"]+)"\)/g)];
      return Object.fromEntries(logins.map(([, alias, login]) => [alias, users[login!] ? { createdAt: users[login!] } : null])) as T;
    },
    async rest<T>(_method: string, path: string): Promise<RestResponse<T>> {
      requests.push(path);
      return { status: path === "/orgs/rust-lang/public_members/member" ? 204 : 404, data: null as T };
    },
  };

  it("loads each author's facts once and replays them as of each PR", async () => {
    const notes: string[] = [];
    const from = new Date("2025-11-27T00:00:00Z");
    const to = new Date("2026-11-27T00:00:00Z");
    const facts = await loadAuthorFacts(gh, { config, authors: ["veteran", "fresh", "member"], from, to, log: () => {}, notes });
    expect(requests).toEqual([
      "is:pr is:merged is:public author:veteran -user:veteran",
      "is:pr is:merged is:public author:fresh -user:fresh",
      "is:pr is:merged is:public author:member -user:member",
      "/orgs/rust-lang/public_members/veteran",
      "/orgs/rust-lang/public_members/fresh",
      "/orgs/rust-lang/public_members/member",
      "created",
    ]);
    expect(notes).toEqual([
      expect.stringMatching(/^merged: \{ repo: any \} reads GitHub search today/),
      expect.stringMatching(/^org_member uses today's public membership of rust-lang for every PR/),
    ]);

    const sources = historicalSources({ own: null, lists: new Map(), merges: new Map(), ...facts });
    const prs = [
      // One merge by others in the 12 months before (the self-merged one never counts).
      pr({ number: 1, author: "veteran", createdAt: "2026-02-01T12:00:00Z" }),
      pr({ number: 2, author: "veteran", createdAt: "2026-03-01T00:00:00Z", state: "MERGED", mergedAt: "2026-03-02T00:00:00Z" }),
      // Two merges, but the account was 28 days old: held back.
      pr({ number: 3, author: "fresh", createdAt: "2026-03-01T00:00:00Z", state: "MERGED", mergedAt: "2026-03-02T00:00:00Z" }),
      pr({ number: 4, author: "fresh", createdAt: "2026-03-05T00:00:00Z" }),
      pr({ number: 5, author: "member", createdAt: "2026-03-01T00:00:00Z" }),
    ];
    const rows = await replay(prs, config, sources, "me/repo");
    expect(rows.map((r) => r.decision?.status)).toEqual(["unknown", "admitted", "unknown", "admitted", "admitted"]);
    expect(rows[2]!.decision).toMatchObject({ heldBack: { rule: "≥2 merged PRs in others' public repos within 12 months" } });
    expect(rows[4]!.decision).toMatchObject({ rule: "public member of rust-lang" });

    const summary = summarize({ repo: "me/repo", from, to, config, ownListPath: null, rows, notes });
    expect(summary.heldBack).toMatchObject({ prs: 1, merged: 1 });
    const text = renderSummary(summary);
    expect(text).toContain("Rules after the own list admit only accounts at least 30 days old (min_account_age).");
    expect(text).toMatch(/\n {2}account too new +1 +1 +1 /);
    expect(text).toContain("org_member uses today's public membership");
  });

  it("refuses to guess when facts were not loaded", () => {
    const sources = historicalSources({ own: null, lists: new Map(), merges: new Map() });
    expect(() => sources.accountCreatedAt("x")).toThrow("No account creation dates loaded");
    expect(() => sources.isPublicOrgMember("o", "x", new Date())).toThrow("No membership of o loaded");
  });
});
