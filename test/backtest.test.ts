import { describe, expect, it } from "vitest";
import { historicalSources, ListHistory, MergeIndex } from "../src/backtest/history.ts";
import { groupOf, outcomeOf, replay } from "../src/backtest/replay.ts";
import { renderSummary, summarize } from "../src/backtest/report.ts";
import { parseConfig } from "../src/engine/config.ts";
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
