import { describeRule, type TrustConfig } from "../engine/config.ts";
import { formatDuration } from "../engine/duration.ts";
import { OWN_LIST, type Decision } from "../engine/rules.ts";
import type { ReplayRow } from "./replay.ts";

export type Counts = {
  prs: number;
  authors: number;
  merged: number;
  rejected: number;
  withdrawn: number;
  autoClosed: number;
  open: number;
};

export type Summary = {
  repo: string;
  window: { from: string; to: string };
  rules: string[];
  /** min_account_age as text, such as "30 days", or null when it is off. */
  minAccountAge: string | null;
  ownListPath: string | null;
  totals: { prs: number; maintainer: number; bot: number; deleted: number; external: number; externalAuthors: number };
  byDecision: Record<Decision["status"], Counts>;
  byRule: Record<string, Counts>;
  /** Unknown PRs that a rule would have admitted but for `min_account_age`; null when it is off. */
  heldBack: Counts | null;
  /** Share of merged external PRs whose author the rules let through. */
  keeps: Rate;
  /** Share of rejected external PRs whose author the rules would have stopped. */
  stops: Rate;
  mergeRate: { allowed: Rate; blocked: Rate };
  newcomers: { blockedOnFirstPr: number; laterMerged: number };
  /** Authors with merged PRs that the rules would have blocked, most merges first. */
  blockedButMerged: { login: string; merged: number }[];
  notes: string[];
};

export type Rate = { part: number; whole: number; value: number | null };

const ALLOWED = new Set<Decision["status"]>(["admitted", "exempt"]);

export function summarize(input: {
  repo: string;
  from: Date;
  to: Date;
  config: TrustConfig;
  ownListPath: string | null;
  rows: ReplayRow[];
  notes: string[];
}): Summary {
  const { rows, config } = input;
  const external = rows.filter((r) => r.group === "external" && r.decision);

  const byDecision = {
    admitted: counts([]),
    exempt: counts([]),
    unknown: counts([]),
    denounced: counts([]),
  } as Record<Decision["status"], Counts>;
  for (const status of Object.keys(byDecision) as Decision["status"][]) {
    byDecision[status] = counts(external.filter((r) => r.decision?.status === status));
  }

  const ruleOrder = [...(config.ownList ? [OWN_LIST] : []), ...config.admit.map(describeRule)];
  const byRule: Record<string, Counts> = {};
  for (const rule of ruleOrder) {
    byRule[rule] = counts(external.filter((r) => r.decision?.status === "admitted" && r.decision.rule === rule));
  }

  const heldBack = config.minAccountAge
    ? counts(external.filter((r) => r.decision?.status === "unknown" && r.decision.heldBack))
    : null;

  const allowed = external.filter((r) => ALLOWED.has(r.decision!.status));
  const blocked = external.filter((r) => !ALLOWED.has(r.decision!.status));
  const merged = external.filter((r) => r.outcome === "merged");
  const rejected = external.filter((r) => r.outcome === "rejected");

  // Newcomers: authors whose first PR in the window would have been blocked.
  const byAuthor = new Map<string, ReplayRow[]>();
  for (const row of external) {
    const key = row.pr.author!.toLowerCase();
    byAuthor.set(key, [...(byAuthor.get(key) ?? []), row]);
  }
  let blockedOnFirstPr = 0;
  let laterMerged = 0;
  for (const authorRows of byAuthor.values()) {
    authorRows.sort((a, b) => a.pr.createdAt.localeCompare(b.pr.createdAt));
    if (ALLOWED.has(authorRows[0]!.decision!.status)) continue;
    blockedOnFirstPr++;
    if (authorRows.some((r) => r.outcome === "merged")) laterMerged++;
  }

  const blockedMergedCounts = new Map<string, number>();
  for (const row of blocked) {
    if (row.outcome !== "merged") continue;
    blockedMergedCounts.set(row.pr.author!, (blockedMergedCounts.get(row.pr.author!) ?? 0) + 1);
  }

  return {
    repo: input.repo,
    window: { from: input.from.toISOString(), to: input.to.toISOString() },
    rules: ruleOrder,
    minAccountAge: config.minAccountAge ? formatDuration(config.minAccountAge) : null,
    ownListPath: input.ownListPath,
    totals: {
      prs: rows.length,
      maintainer: rows.filter((r) => r.group === "maintainer").length,
      bot: rows.filter((r) => r.group === "bot").length,
      deleted: rows.filter((r) => r.group === "deleted").length,
      external: external.length,
      externalAuthors: byAuthor.size,
    },
    byDecision,
    byRule,
    heldBack,
    keeps: rate(merged.filter((r) => ALLOWED.has(r.decision!.status)).length, merged.length),
    stops: rate(rejected.filter((r) => !ALLOWED.has(r.decision!.status)).length, rejected.length),
    mergeRate: { allowed: mergeRateOf(counts(allowed)), blocked: mergeRateOf(counts(blocked)) },
    newcomers: { blockedOnFirstPr, laterMerged },
    blockedButMerged: [...blockedMergedCounts]
      .map(([login, n]) => ({ login, merged: n }))
      .sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login)),
    notes: input.notes,
  };
}

export function counts(rows: ReplayRow[]): Counts {
  const c: Counts = { prs: rows.length, authors: 0, merged: 0, rejected: 0, withdrawn: 0, autoClosed: 0, open: 0 };
  const authors = new Set<string>();
  for (const row of rows) {
    if (row.pr.author) authors.add(row.pr.author.toLowerCase());
    if (row.outcome === "merged") c.merged++;
    else if (row.outcome === "rejected") c.rejected++;
    else if (row.outcome === "withdrawn") c.withdrawn++;
    else if (row.outcome === "auto_closed") c.autoClosed++;
    else c.open++;
  }
  c.authors = authors.size;
  return c;
}

/** merged ÷ (merged + rejected + withdrawn). Open and bot-closed PRs carry no human verdict. */
export function mergeRate(c: Counts): number | null {
  const decided = c.merged + c.rejected + c.withdrawn;
  return decided === 0 ? null : c.merged / decided;
}

function mergeRateOf(c: Counts): Rate {
  return rate(c.merged, c.merged + c.rejected + c.withdrawn);
}

export function rate(part: number, whole: number): Rate {
  return { part, whole, value: whole === 0 ? null : part / whole };
}

export const pct = (value: number | null) => (value === null ? "–" : `${Math.round(value * 100)}%`);
const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const ofWhole = (r: Rate) => `${pct(r.value)} (${num(r.part)} of ${num(r.whole)})`;

export function renderSummary(s: Summary): string {
  const out: string[] = [];
  out.push(`Backtest: ${s.repo}`);
  out.push(`PRs opened ${s.window.from.slice(0, 10)} to ${s.window.to.slice(0, 10)}`);
  out.push("");
  out.push("Rules, checked in order:");
  s.rules.forEach((rule, i) => {
    const detail = rule === OWN_LIST ? ` (${s.ownListPath ?? "none found"})` : "";
    out.push(`  ${i + 1}. ${rule}${detail}`);
  });
  if (s.minAccountAge) out.push(`Rules after the own list admit only accounts at least ${s.minAccountAge} old (min_account_age).`);
  out.push("");

  const t = s.totals;
  out.push(`${num(t.prs)} PRs: ${num(t.maintainer)} by maintainers, ${num(t.bot)} by bots, ${num(t.deleted)} by deleted accounts,`);
  out.push(`${num(t.external)} by ${num(t.externalAuthors)} external authors. Only external PRs meet the rules.`);
  out.push("");

  const header = ["", "PRs", "authors", "merged", "rejected", "withdrawn", "bot-closed", "open", "merge rate"];
  const table: string[][] = [header];
  const line = (label: string, c: Counts) => [
    label,
    num(c.prs),
    num(c.authors),
    num(c.merged),
    num(c.rejected),
    num(c.withdrawn),
    num(c.autoClosed),
    num(c.open),
    pct(mergeRate(c)),
  ];
  table.push(line("admitted", s.byDecision.admitted));
  for (const [rule, c] of Object.entries(s.byRule)) table.push(line(`  via ${rule}`, c));
  if (s.byDecision.exempt.prs > 0) table.push(line("exempt paths", s.byDecision.exempt));
  table.push(line("unknown (blocked)", s.byDecision.unknown));
  if (s.heldBack) table.push(line("  account too new", s.heldBack));
  if (s.byDecision.denounced.prs > 0) table.push(line("denounced", s.byDecision.denounced));
  out.push(...renderTable(table));
  out.push("");
  out.push("merge rate = merged ÷ (merged + rejected + withdrawn); open and bot-closed PRs are left out.");
  out.push("");

  out.push("Result");
  out.push(`  Keeps ${ofWhole(s.keeps)} of merged external PRs.`);
  out.push(`  Stops ${ofWhole(s.stops)} of rejected external PRs.`);
  out.push(`  PRs it lets through were merged ${ofWhole(s.mergeRate.allowed)}.`);
  out.push(`  PRs it blocks were merged ${ofWhole(s.mergeRate.blocked)}.`);
  out.push("");

  const lost = s.blockedButMerged.reduce((sum, a) => sum + a.merged, 0);
  out.push("Cost");
  out.push(`  ${plural(lost, "merged PR")} from ${plural(s.blockedButMerged.length, "author")} would have been blocked.`);
  out.push(
    `  ${plural(s.newcomers.blockedOnFirstPr, "author")} would have been blocked on their first PR; ` +
      `${num(s.newcomers.laterMerged)} of them had a PR merged in the window.`,
  );
  if (s.blockedButMerged.length > 0) {
    const top = s.blockedButMerged.slice(0, 8).map((a) => `${a.login} (${a.merged})`);
    out.push(`  Most affected: ${top.join(", ")}`);
  }

  if (s.notes.length > 0) {
    out.push("");
    out.push("Notes");
    for (const note of s.notes) out.push(`  - ${note}`);
  }
  return out.join("\n");
}

export function renderComparison(summaries: Summary[]): string {
  const rows: string[][] = [
    ["repo", "external PRs", "keeps", "stops", "merge rate: let through", "merge rate: blocked", "merged PRs blocked"],
  ];
  for (const s of summaries) {
    rows.push([
      s.repo,
      num(s.totals.external),
      pct(s.keeps.value),
      pct(s.stops.value),
      pct(s.mergeRate.allowed.value),
      pct(s.mergeRate.blocked.value),
      num(s.blockedButMerged.reduce((sum, a) => sum + a.merged, 0)),
    ]);
  }
  return renderTable(rows).join("\n");
}

export function renderTable(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? "").length)));
  return rows.map((r) =>
    r
      .map((cell, col) => (col === 0 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!)))
      .join("  ")
      .trimEnd(),
  );
}
