import { describe, expect, it } from "vitest";
import { ListHistory, MergeIndex, type HistoricalData } from "../src/backtest/history.ts";
import { replay } from "../src/backtest/replay.ts";
import { summarize } from "../src/backtest/report.ts";
import {
  candidateRules,
  loadSuggestionFacts,
  renderSuggestions,
  suggest,
  suggestionSources,
  type SuggestionFacts,
} from "../src/backtest/suggest.ts";
import { listKey, parseConfig, type Rule } from "../src/engine/config.ts";
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
const merged = (number: number, author: string) => pr({ number, author, state: "MERGED", mergedAt: "2026-03-02T00:00:00Z" });
const rejected = (number: number, author: string) => pr({ number, author, state: "CLOSED", closedBy: "maint" });

const repo = "me/repo";
const from = new Date("2025-11-27T00:00:00Z");
const to = new Date("2026-11-27T00:00:00Z");
const config = parseConfig("own_list: none\nadmit:\n  - merged: { repo: self, min: 1, within: 12mo }\n");

// regular: admitted by the current rules. good1, good2: vouched in a/list. good3: merged elsewhere,
// old account. spam1, spam2: merged elsewhere once, accounts days old. spam3: nothing.
const prs = [
  merged(1, "regular"),
  merged(2, "good1"),
  merged(3, "good2"),
  merged(4, "good3"),
  rejected(5, "spam1"),
  rejected(6, "spam2"),
  rejected(7, "spam3"),
  rejected(8, "regular"),
  pr({ number: 9, author: "drifter" }), // open: no verdict, never tried
];
const helps: Rule = { kind: "list", source: { repo: "a/list", path: null } };
const empty: Rule = { kind: "list", source: { repo: "b/list", path: null } };
const anywhere: Rule = { kind: "merged", repo: "any", min: 1, within: { amount: 24, unit: "mo" } };

const data: HistoricalData = {
  own: null,
  lists: new Map([
    [listKey(helps.kind === "list" ? helps.source : { repo: "", path: null }), new ListHistory("VOUCHED.td", [{ at: "2025-01-01T00:00:00Z", text: "good1\ngood2\n" }])],
    [listKey({ repo: "b/list", path: null }), new ListHistory("VOUCHED.td", [{ at: "2025-01-01T00:00:00Z", text: "someone-else\n" }])],
  ]),
  merges: new Map([[repo, new MergeIndex([{ author: "regular", mergedAt: "2025-12-01T00:00:00Z", mergedBy: null }])]]),
  accountCreated: new Map([
    ["regular", "2015-01-01T00:00:00Z"],
    ["good3", "2016-01-01T00:00:00Z"],
    ["spam1", "2026-02-25T00:00:00Z"],
    ["spam2", "2026-02-26T00:00:00Z"],
  ]),
};
const facts: SuggestionFacts = {
  data,
  elsewhere: {
    index: new MergeIndex(["good3", "spam1", "spam2"].map((author) => ({ author, mergedAt: "2026-01-10T00:00:00Z", mergedBy: null }))),
    authors: new Set(["good3", "spam1", "spam2", "spam3"]),
  },
  authors: { needed: 6, searched: 4 },
  notes: ["a note"],
};

async function run(rules: Rule[], withFloor = true) {
  const rows = await replay(prs, config, suggestionSources(facts), repo);
  const summary = summarize({ repo, from, to, config, ownListPath: null, rows, notes: [] });
  return suggest({ repo, config, summary, rows, sources: suggestionSources(facts), rules, withFloor, authors: facts.authors, notes: facts.notes });
}

describe("suggest", () => {
  it("measures each candidate's gain and cost against the current rules", async () => {
    const s = await run([empty, anywhere, helps]);
    expect(s.current.keeps).toEqual({ part: 1, whole: 4, value: 0.25 });
    expect(s.current.stops).toEqual({ part: 3, whole: 4, value: 0.75 });
    expect(s.tried).toEqual({ prs: 6, merged: 3, rejected: 3 });
    expect(s.blockedMerged).toBe(3);
    expect(s.candidates.map((c) => [c.label, c.gain, c.cost, c.keeps.value, c.stops.value])).toEqual([
      ["vouched in a/list", 2, 0, 0.75, 0.75],
      // The floor holds back the two new accounts, so the rule's cost disappears.
      ["≥1 merged PR in others' public repos within 24 months + min_account_age 30d", 1, 0, 0.5, 0.75],
      ["vouched in b/list", 0, 0, 0.25, 0.75],
      ["≥1 merged PR in others' public repos within 24 months", 1, 2, 0.5, 0.25],
    ]);
    expect(s.verdict).toEqual([]);
    expect(s.best.map((b) => b.label)).toEqual(["vouched in a/list", "≥1 merged PR in others' public repos within 24 months + min_account_age 30d"]);
  });

  it("renders one compact table, then the best rules as YAML", async () => {
    const text = renderSuggestions(await run([empty, anywhere, helps]));
    expect(text).toContain(
      [
        "rule added                                                                   +merged  +rejected  keeps  stops",
        "(current rules)                                                                                    25%    75%",
        "vouched in a/list                                                                 +2          0    75%    75%",
        "≥1 merged PR in others' public repos within 24 months + min_account_age 30d       +1          0    50%    75%",
        "≥1 merged PR in others' public repos within 24 months                             +1         +2    50%    25%",
        "Sorted by merged PRs gained minus rejected PRs also let through.",
        "No change: vouched in b/list.",
      ].join("\n"),
    );
    expect(text).toContain("Best: vouched in a/list\n  Would have let through 2 more merged PRs and no rejected PRs: keeps 25% → 75%, stops 75% → 75%.");
    expect(text).toContain(
      ["    own_list: none", "    admit:", "      - merged: { repo: self, min: 1, within: 12mo }", "      - list: a/list  # new"].join("\n"),
    );
    expect(text).toContain("      - merged: { repo: any, min: 1, within: 24mo }  # new\n    min_account_age: 30d  # new");
    expect(text).toContain("Notes on the suggestions\n  - a note");
  });

  it("prints YAML that parses back to the config plus the rule", async () => {
    const s = await run([empty, anywhere, helps]);
    const parsed = parseConfig(s.best[1]!.yaml);
    expect(parsed.admit).toEqual([...config.admit, anywhere]);
    expect(parsed.minAccountAge).toEqual({ amount: 30, unit: "d" });
  });

  it("says so when nothing helps much and what helps lets most rejected PRs through", async () => {
    const s = await run([empty, anywhere], false);
    expect(s.best).toEqual([]);
    expect(s.verdict).toEqual([
      "No candidate helps much: the most any recovers is 1 of the 3 merged PRs blocked today.",
      "Every rule that helps would also let through most of the 3 rejected PRs the current rules stop.",
      "Every rule that helps lets through at least as many rejected PRs as merged ones; none is suggested.",
    ]);
    const none = await run([empty]);
    expect(none.verdict).toEqual(["None of these rules would have let through any of the 3 merged PRs the current rules block."]);
  });

  it("has a stable JSON shape", async () => {
    const json = JSON.parse(JSON.stringify(await run([empty, anywhere, helps])));
    expect(Object.keys(json)).toEqual(["current", "blockedMerged", "tried", "authors", "candidates", "best", "verdict", "notes"]);
    expect(json.candidates[0]).toEqual({
      rule: "list: a/list",
      label: "vouched in a/list",
      minAccountAge: null,
      gain: 2,
      cost: 0,
      keeps: { part: 3, whole: 4, value: 0.75 },
      stops: { part: 3, whole: 4, value: 0.75 },
    });
    expect(json.best[0]).toEqual({ label: "vouched in a/list", yaml: expect.stringContaining("- list: a/list  # new"), reading: expect.any(String) });
    expect(json.authors).toEqual({ needed: 6, searched: 4 });
  });
});

describe("candidateRules", () => {
  it("skips rules and lists the config already has", () => {
    const rules = candidateRules(
      parseConfig("admit:\n  - merged: { repo: any, min: 3, within: 24mo }\n  - list: mitchellh/vouch\n"),
      "ghostty-org/ghostty",
    );
    const text = rules.map((r) => (r.kind === "list" ? r.source.repo : `any ${r.kind === "merged" ? r.min : ""}`));
    expect(text).toContain("any 1");
    expect(text).not.toContain("any 3");
    expect(text).toContain("any 10");
    expect(text).not.toContain("mitchellh/vouch");
    expect(text).not.toContain("ghostty-org/ghostty"); // the own list already covers it
    expect(text).toContain("hyprwm/.github");
  });
});

describe("loadSuggestionFacts", () => {
  it("searches only authors a candidate could change, most PRs first, and says when capped", async () => {
    const searched: string[] = [];
    let createdBatches = 0;
    const gh: GitHubClient = {
      stats: { requests: 0, cached: 0 },
      async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
        if (query.includes("search(")) {
          searched.push(/author:(\S+)/.exec(variables.q as string)![1]!);
          return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } as T;
        }
        createdBatches++;
        return {} as T;
      },
      async rest<T>(): Promise<RestResponse<T>> {
        throw new Error("no REST expected");
      },
    };
    const rows = await replay(
      [...prs, rejected(10, "spam3"), pr({ number: 11, author: "drifter", state: "CLOSED", closedBy: "drifter" })],
      config,
      suggestionSources(facts),
      repo,
    );
    const notes: string[] = [];
    const loaded = await loadSuggestionFacts(gh, { config, data, rows, rules: [anywhere], from, to, maxAuthors: 2, log: (m) => notes.push(m) });
    // spam3 has two rejected PRs; then alphabetical. drifter (open, withdrawn) and regular (admitted) are never searched.
    expect(searched).toEqual(["spam3", "good1"]);
    expect(createdBatches).toBe(1);
    expect(loaded.authors).toEqual({ needed: 6, searched: 2 });
    expect(loaded.notes).toEqual([
      expect.stringMatching(/^merged: \{ repo: any \} reads GitHub search today/),
      expect.stringMatching(/^Capped: merges elsewhere were searched for 2 of 6 authors .* The other 4 authors' 4 PR\(s\) count as not matching/),
    ]);
    expect(notes).toContain("  2 of 2 authors");
  });
});
