import { ANY, describeRule, listKey, type Rule, type TrustConfig } from "../engine/config.ts";
import { subtractDuration, type Duration } from "../engine/duration.ts";
import type { TrustSources } from "../engine/rules.ts";
import { normalizeLogin } from "../engine/vouchfile.ts";
import type { GitHubClient } from "../github/client.ts";
import { fetchAccountCreation, fetchMergedElsewhere, type MergedRow, type Progress } from "../github/queries.ts";
import { CATALOG_LISTS } from "./catalog.ts";
import { historicalSources, MergeIndex, type HistoricalData } from "./history.ts";
import { loadList } from "./load.ts";
import { replay, type ReplayRow } from "./replay.ts";
import { pct, rate, renderTable, type Rate, type Summary } from "./report.ts";

/** `within` for the `merged: { repo: any }` candidates. */
export const SUGGEST_WITHIN: Duration = { amount: 24, unit: "mo" };
/** The account-age floor tried alongside candidates that help. */
export const SUGGEST_FLOOR: Duration = { amount: 30, unit: "d" };
/** Authors searched for `merged: { repo: any }` by default; GitHub search allows about 30 requests a minute. */
export const DEFAULT_SUGGEST_AUTHORS = 100;

/**
 * The fixed set of extra rules to try: merges anywhere at three thresholds, and every
 * catalogued trust list the config does not already use.
 */
export function candidateRules(config: TrustConfig, repo: string): Rule[] {
  const rules: Rule[] = [];
  const existing = new Set(config.admit.map(ruleYaml));
  for (const min of [1, 3, 10]) {
    const rule: Rule = { kind: "merged", repo: ANY, min, within: SUGGEST_WITHIN };
    if (!existing.has(ruleYaml(rule))) rules.push(rule);
  }
  const listed = new Set(config.admit.flatMap((r) => (r.kind === "list" ? [r.source.repo.toLowerCase()] : [])));
  // The project's own list is already checked first.
  if (config.ownList) listed.add(repo.toLowerCase());
  for (const source of CATALOG_LISTS) {
    if (!listed.has(source.repo.toLowerCase())) rules.push({ kind: "list", source });
  }
  return rules;
}

/** External PRs with a maintainer's verdict: the only ones that move keeps and stops. */
function decided(row: ReplayRow): boolean {
  return row.group === "external" && row.decision !== null && (row.outcome === "merged" || row.outcome === "rejected");
}

/**
 * Decided PRs the current rules leave unknown, where a rule added at the end could change the
 * verdict (an account held back by min_account_age stops before any later rule).
 */
function reachable(row: ReplayRow): boolean {
  return decided(row) && row.decision?.status === "unknown" && !row.decision.heldBack;
}

export type SuggestionFacts = {
  data: HistoricalData;
  /** Merges elsewhere for the authors searched here, or null when the config's own were enough. */
  elsewhere: { index: MergeIndex; authors: Set<string> } | null;
  /** Authors whose PRs a candidate could change, and how many of them were searched. */
  authors: { needed: number; searched: number };
  notes: string[];
};

/**
 * Loads what the candidates need and nothing else: the catalogued lists' histories, merges
 * elsewhere for authors of unknown PRs that were merged or rejected (most such PRs first, at
 * most `maxAuthors`), and account creation dates when the config has no floor yet.
 */
export async function loadSuggestionFacts(
  gh: GitHubClient,
  input: {
    config: TrustConfig;
    data: HistoricalData;
    rows: ReplayRow[];
    rules: Rule[];
    from: Date;
    to: Date;
    maxAuthors: number;
    log?: Progress;
  },
): Promise<SuggestionFacts> {
  const { config, rows, rules, from, to, maxAuthors } = input;
  const log = input.log ?? (() => {});
  const notes: string[] = [];
  const lists = new Map(input.data.lists);
  const data: HistoricalData = { ...input.data, lists };

  const listRules = rules.filter((r) => r.kind === "list");
  for (const [i, rule] of listRules.entries()) {
    if (rule.kind !== "list" || lists.has(listKey(rule.source))) continue;
    log(`suggest: trust list ${i + 1} of ${listRules.length}`);
    lists.set(listKey(rule.source), await loadList(gh, rule.source, (m) => log(`  ${m}`)));
  }
  const missing = listRules.filter((r) => r.kind === "list" && !lists.get(listKey(r.source)));
  if (missing.length > 0) {
    notes.push(`No trust list found in ${missing.map((r) => (r.kind === "list" ? r.source.repo : "")).join(", ")}; those rules never match.`);
  }

  const perAuthor = new Map<string, number>();
  for (const row of rows) {
    if (!reachable(row)) continue;
    const login = normalizeLogin(row.pr.author!);
    perAuthor.set(login, (perAuthor.get(login) ?? 0) + 1);
  }
  const needed = [...perAuthor].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([login]) => login);

  // Search from as far back as any `any` rule needs, so the config's own `any` rules give the
  // same answers for searched authors (and the query matches the main run's, hitting the cache).
  const starts = [subtractDuration(from, SUGGEST_WITHIN), ...config.admit.flatMap((r) => (r.kind === "merged" && r.repo === ANY ? [subtractDuration(from, r.within)] : []))];
  const start = new Date(Math.min(...starts.map((d) => d.getTime())));
  const covered = input.data.elsewhere !== undefined && config.admit.some((r) => r.kind === "merged" && r.repo === ANY && subtractDuration(from, r.within) <= start);

  let elsewhere: SuggestionFacts["elsewhere"] = null;
  let searched = needed.length;
  if (!covered && rules.some((r) => r.kind === "merged" && r.repo === ANY) && needed.length > 0) {
    const chosen = needed.slice(0, maxAuthors);
    searched = chosen.length;
    log(`suggest: searching merged PRs elsewhere for ${chosen.length} authors since ${start.toISOString().slice(0, 10)} (search allows about 30 requests a minute)`);
    const found: MergedRow[] = [];
    const authors = new Set<string>();
    for (const [i, login] of chosen.entries()) {
      if ((i + 1) % 10 === 0 || i + 1 === chosen.length) log(`  ${i + 1} of ${chosen.length} authors`);
      try {
        for (const mergedAt of await fetchMergedElsewhere(gh, login, start, to)) found.push({ author: login, mergedAt, mergedBy: null });
        authors.add(login);
      } catch (error) {
        log(`  ${login}: ${(error as Error).message}`);
      }
    }
    elsewhere = { index: new MergeIndex(found), authors };
    notes.push(
      'merged: { repo: any } reads GitHub search today: merges in repositories since deleted or made private are ' +
        "missed, and repository owners are today's.",
    );
    if (authors.size < chosen.length) notes.push(`Merges elsewhere could not be searched for ${chosen.length - authors.size} author(s); for them "any" rules never matched.`);
    if (needed.length > chosen.length) {
      const left = new Set(needed.slice(chosen.length));
      const prs = rows.filter((r) => reachable(r) && left.has(normalizeLogin(r.pr.author!))).length;
      notes.push(
        `Capped: merges elsewhere were searched for ${chosen.length} of ${needed.length} authors (those with the most merged or ` +
          `rejected unknown PRs). The other ${left.size} authors' ${prs} PR(s) count as not matching, so gains and costs ` +
          `for merged: { repo: any } are lower bounds. Raise the cap with --suggest-authors.`,
      );
    }
  }

  if (!config.minAccountAge) {
    const everyone = [...new Set(rows.filter(decided).map((r) => normalizeLogin(r.pr.author!)))];
    log(`suggest: reading account creation dates for ${everyone.length} authors`);
    data.accountCreated = await fetchAccountCreation(gh, everyone);
  }
  return { data, elsewhere, authors: { needed: needed.length, searched }, notes };
}

export function suggestionSources(facts: SuggestionFacts): TrustSources {
  const base = historicalSources(facts.data);
  const own = facts.elsewhere;
  if (!own) return base;
  return {
    ...base,
    mergedElsewhereCount: (login, from, to, min) => {
      if (own.authors.has(normalizeLogin(login))) return own.index.count(login, from, to);
      return facts.data.elsewhere ? base.mergedElsewhereCount(login, from, to, min) : 0;
    },
  };
}

export type Candidate = {
  /** The rule as written in a rules file, such as "merged: { repo: any, min: 3, within: 24mo }". */
  rule: string;
  label: string;
  /** min_account_age added with the rule, such as "30d", or null. */
  minAccountAge: string | null;
  /** Merged outside PRs it would also have let through (negative when the floor holds some back). */
  gain: number;
  /** Rejected outside PRs it would also have let through. */
  cost: number;
  keeps: Rate;
  stops: Rate;
};

export type Pick = { label: string; yaml: string; reading: string };

export type Suggestions = {
  current: { keeps: Rate; stops: Rate };
  /** Merged outside PRs the current rules block. */
  blockedMerged: number;
  /** Unknown PRs with a maintainer's verdict that candidates were tried on. */
  tried: { prs: number; merged: number; rejected: number };
  authors: { needed: number; searched: number };
  /** Most net gain first (gain − cost). */
  candidates: Candidate[];
  best: Pick[];
  verdict: string[];
  notes: string[];
};

/**
 * Replays the config with each candidate appended, as of each PR's open time, and with
 * `withFloor` also each helpful candidate plus a 30-day account-age floor.
 */
export async function suggest(input: {
  repo: string;
  config: TrustConfig;
  summary: Summary;
  rows: ReplayRow[];
  sources: TrustSources;
  rules: Rule[];
  maintainers?: ReadonlySet<string>;
  withFloor: boolean;
  authors: { needed: number; searched: number };
  notes: string[];
}): Promise<Suggestions> {
  const { repo, config, summary, sources } = input;
  const maintainers = input.maintainers ?? new Set<string>();
  const all = input.rows.filter(decided);
  const unknown = all.filter(reachable);
  const allowedNow = { merged: summary.keeps.part, rejected: summary.stops.whole - summary.stops.part };

  const allowedUnder = async (rows: ReplayRow[], cfg: TrustConfig) => {
    const replayed = await replay(rows.map((r) => r.pr), cfg, sources, repo, maintainers);
    const allowed = replayed.filter((r) => r.decision?.status === "admitted" || r.decision?.status === "exempt");
    return { merged: allowed.filter((r) => r.outcome === "merged").length, rejected: allowed.filter((r) => r.outcome === "rejected").length };
  };
  const candidate = (rule: Rule, floor: Duration | null, gain: number, cost: number): Candidate => ({
    rule: ruleYaml(rule),
    label: describeRule(rule) + (floor ? ` + min_account_age ${durationYaml(floor)}` : ""),
    minAccountAge: floor ? durationYaml(floor) : null,
    gain,
    cost,
    keeps: rate(summary.keeps.part + gain, summary.keeps.whole),
    stops: rate(summary.stops.part - cost, summary.stops.whole),
  });

  const candidates: Candidate[] = [];
  const configs = new Map<Candidate, { rule: Rule; floor: Duration | null }>();
  for (const rule of input.rules) {
    const withRule: TrustConfig = { ...config, admit: [...config.admit, rule] };
    // Only the unknown PRs can change: earlier rules still admit everyone they did.
    const plain = await allowedUnder(unknown, withRule);
    const c = candidate(rule, null, plain.merged, plain.rejected);
    candidates.push(c);
    configs.set(c, { rule, floor: null });
    if (!input.withFloor || config.minAccountAge || plain.merged === 0) continue;
    // A floor can hold back PRs the current rules admit, so replay every decided PR.
    const floored = await allowedUnder(all, { ...withRule, minAccountAge: SUGGEST_FLOOR });
    const f = candidate(rule, SUGGEST_FLOOR, floored.merged - allowedNow.merged, floored.rejected - allowedNow.rejected);
    // Shown only when the floor stops something the rule alone lets through.
    if (f.cost < c.cost) {
      candidates.push(f);
      configs.set(f, { rule, floor: SUGGEST_FLOOR });
    }
  }
  // On a tie the stricter rule goes first: the same past result with less exposure later.
  const strictness = (c: Candidate) => {
    const { rule, floor } = configs.get(c)!;
    return (rule.kind === "merged" ? rule.min : 0) + (floor ? 0.5 : 0);
  };
  candidates.sort(
    (a, b) =>
      b.gain - b.cost - (a.gain - a.cost) || b.gain - a.gain || a.cost - b.cost || strictness(b) - strictness(a) || a.label.localeCompare(b.label),
  );

  const blockedMerged = summary.keeps.whole - summary.keeps.part;
  const helpful = candidates.filter((c) => c.gain > 0);
  // A runner-up with the very same result adds nothing to choose between.
  const winners: Candidate[] = [];
  for (const c of candidates) {
    if (winners.length < 2 && c.gain > c.cost && !winners.some((w) => w.gain === c.gain && w.cost === c.cost)) winners.push(c);
  }
  const verdict: string[] = [];
  if (blockedMerged === 0) {
    verdict.push("The current rules already let through every merged outside PR; there is nothing to recover.");
  } else if (helpful.length === 0) {
    verdict.push(`None of these rules would have let through any of the ${blockedMerged} merged PRs the current rules block.`);
  } else {
    const most = Math.max(...helpful.map((c) => c.gain));
    if (most < Math.max(2, Math.ceil(blockedMerged / 10))) {
      verdict.push(`No candidate helps much: the most any recovers is ${most} of the ${blockedMerged} merged PRs blocked today.`);
    }
    const stopped = summary.stops.part;
    if (stopped > 0 && helpful.every((c) => c.cost * 2 > stopped)) {
      verdict.push(`Every rule that helps would also let through most of the ${stopped} rejected PRs the current rules stop.`);
    }
    if (winners.length === 0) {
      verdict.push("Every rule that helps lets through at least as many rejected PRs as merged ones; none is suggested.");
    }
  }

  const notes = [...input.notes];
  const botClosed = input.rows.filter((r) => r.group === "external" && r.decision?.status === "unknown" && r.outcome === "auto_closed").length;
  if (botClosed > 0) {
    notes.push(
      `${botClosed} unknown PR(s) were closed by a bot (an existing gate or a stale bot) and have no maintainer verdict, ` +
        "so what a candidate would have let through among them is not counted either way.",
    );
  }
  const current = { keeps: summary.keeps, stops: summary.stops };
  const best = winners.map((c) => {
    const { rule, floor } = configs.get(c)!;
    return { label: c.label, yaml: configYaml(config, rule, floor), reading: reading(c, current) };
  });

  return {
    current,
    blockedMerged,
    tried: {
      prs: unknown.length,
      merged: unknown.filter((r) => r.outcome === "merged").length,
      rejected: unknown.filter((r) => r.outcome === "rejected").length,
    },
    authors: input.authors,
    candidates,
    best,
    verdict,
    notes,
  };
}

function reading(c: Candidate, current: { keeps: Rate; stops: Rate }): string {
  const more = (n: number, what: string) => (n === 0 ? `no ${what} PRs` : `${n} more ${what} ${n === 1 ? "PR" : "PRs"}`);
  return (
    `Would have let through ${more(c.gain, "merged")} and ${more(c.cost, "rejected")}: ` +
    `keeps ${pct(current.keeps.value)} → ${pct(c.keeps.value)}, stops ${pct(current.stops.value)} → ${pct(c.stops.value)}.`
  );
}

export function renderSuggestions(s: Suggestions): string {
  const out: string[] = [];
  out.push("Suggestions");
  out.push(
    `Extra rules tried, each added last, on the ${s.tried.prs} unknown outside PRs that maintainers merged (${s.tried.merged}) ` +
      `or rejected (${s.tried.rejected}), as of each PR's open time.`,
  );
  out.push("");
  const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");
  const shown = s.candidates.filter((c) => c.gain !== 0 || c.cost !== 0);
  const idle = s.candidates.filter((c) => c.gain === 0 && c.cost === 0);
  const table: string[][] = [["rule added", "+merged", "+rejected", "keeps", "stops"]];
  table.push(["(current rules)", "", "", pct(s.current.keeps.value), pct(s.current.stops.value)]);
  for (const c of shown) table.push([c.label, signed(c.gain), signed(c.cost), pct(c.keeps.value), pct(c.stops.value)]);
  out.push(...renderTable(table));
  out.push("Sorted by merged PRs gained minus rejected PRs also let through.");
  if (idle.length > 0) {
    const lists = idle.filter((c) => c.rule.startsWith("list: ")).map((c) => c.rule.slice("list: ".length));
    const others = idle.filter((c) => !c.rule.startsWith("list: ")).map((c) => c.label);
    if (lists.length > 0) others.push(`vouched in ${lists.join(", ")}`);
    out.push(`No change: ${others.join("; ")}.`);
  }
  out.push("");

  for (const line of s.verdict) out.push(line);
  if (s.verdict.length > 0) out.push("");

  s.best.forEach((pick, i) => {
    out.push(`${i === 0 ? "Best" : "Next best"}: ${pick.label}`);
    out.push(`  ${pick.reading}`);
    out.push("");
    out.push(...pick.yaml.trimEnd().split("\n").map((line) => `    ${line}`));
    out.push("");
  });

  if (s.notes.length > 0) {
    out.push("Notes on the suggestions");
    for (const note of s.notes) out.push(`  - ${note}`);
  }
  return out.join("\n").trimEnd();
}

export function durationYaml(d: Duration): string {
  return `${d.amount}${d.unit}`;
}

export function ruleYaml(rule: Rule): string {
  if (rule.kind === "list") return `list: ${rule.source.repo}${rule.source.path ? `:${rule.source.path}` : ""}`;
  if (rule.kind === "org_member") return `org_member: ${rule.org}`;
  return `merged: { repo: ${rule.repo}, min: ${rule.min}, within: ${durationYaml(rule.within)} }`;
}

/** The rules part of a config with `rule` added, ready to paste; other settings stay as they are. */
export function configYaml(config: TrustConfig, rule: Rule, floor: Duration | null): string {
  const own = config.ownList === null ? "none" : (config.ownList.path ?? "auto");
  const lines = [`own_list: ${own}`, "admit:"];
  for (const r of config.admit) lines.push(`  - ${ruleYaml(r)}`);
  lines.push(`  - ${ruleYaml(rule)}  # new`);
  if (config.minAccountAge) lines.push(`min_account_age: ${durationYaml(config.minAccountAge)}`);
  else if (floor) lines.push(`min_account_age: ${durationYaml(floor)}  # new`);
  return `${lines.join("\n")}\n`;
}
