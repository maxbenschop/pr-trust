import { listKey, SELF, VOUCH_FILE_CANDIDATES, type ListRef, type TrustConfig } from "../engine/config.ts";
import { subtractDuration } from "../engine/duration.ts";
import type { GraphQLClient } from "../github/client.ts";
import {
  fetchFileVersions,
  fetchMerged,
  fetchPullRequests,
  type Progress,
  type PullRequestRow,
} from "../github/queries.ts";
import { ListHistory, MergeIndex, type HistoricalData } from "./history.ts";

export type BacktestData = HistoricalData & {
  prs: PullRequestRow[];
  /** Logins seen acting with repo permissions: merging PRs or closing other people's. */
  maintainers: Set<string>;
  notes: string[];
};

export async function loadBacktestData(
  gh: GraphQLClient,
  input: { repo: string; config: TrustConfig; from: Date; to: Date; log?: Progress },
): Promise<BacktestData> {
  const { repo, config, from, to } = input;
  const log = input.log ?? (() => {});
  const notes: string[] = [];

  log(`fetching PRs opened in ${repo}`);
  const prs = await fetchPullRequests(gh, repo, from, to, {
    withFiles: config.exemptPaths.length > 0,
    onProgress: (m) => log(`  ${m}`),
  });

  let own: ListHistory | null = null;
  if (config.ownList) {
    own = await loadList(gh, { repo, path: config.ownList.path }, log);
    if (!own) notes.push(`No own trust list found in ${repo}; the own-list check never matched.`);
    else if (own.versionCount > 0 && own.at(from) === null) {
      notes.push(`${repo}'s own list (${own.path}) first appeared during the window; PRs before that saw no list.`);
    }
  }

  const lists = new Map<string, ListHistory | null>();
  for (const rule of config.admit) {
    if (rule.kind !== "list" || lists.has(listKey(rule.source))) continue;
    const history = await loadList(gh, rule.source, log);
    if (!history) notes.push(`No trust list found in ${rule.source.repo}; that rule never matched.`);
    lists.set(listKey(rule.source), history);
  }

  // One merge index per repository, reaching back as far as the longest `within` for it.
  const earliest = new Map<string, Date>();
  for (const rule of config.admit) {
    if (rule.kind !== "merged") continue;
    const target = (rule.repo === SELF ? repo : rule.repo).toLowerCase();
    const start = subtractDuration(from, rule.within);
    const current = earliest.get(target);
    if (!current || start < current) earliest.set(target, start);
  }
  // This repo's merges are always needed: whoever merged a PR has write access.
  const self = repo.toLowerCase();
  const selfStart = subtractDuration(from, { amount: 12, unit: "mo" });
  if (!earliest.has(self) || selfStart < earliest.get(self)!) earliest.set(self, selfStart);

  const merges = new Map<string, MergeIndex>();
  const maintainers = new Set<string>();
  for (const [target, start] of earliest) {
    log(`fetching merged PRs in ${target} since ${start.toISOString().slice(0, 10)}`);
    const rows = await fetchMerged(gh, target, start, to, (m) => log(`  ${m}`));
    merges.set(target, new MergeIndex(rows));
    if (target === self) {
      for (const row of rows) if (row.mergedBy) maintainers.add(row.mergedBy.toLowerCase());
    }
  }
  // Closing someone else's PR needs triage access or more.
  for (const pr of prs) {
    if (pr.state === "CLOSED" && pr.closedBy && pr.author && pr.closedBy.toLowerCase() !== pr.author.toLowerCase()) {
      maintainers.add(pr.closedBy.toLowerCase());
    }
  }

  return { prs, maintainers, own, lists, merges, notes };
}

async function loadList(gh: GraphQLClient, ref: ListRef, log: Progress): Promise<ListHistory | null> {
  const candidates = ref.path ? [ref.path] : VOUCH_FILE_CANDIDATES;
  for (const path of candidates) {
    log(`fetching history of ${ref.repo}:${path}`);
    const versions = await fetchFileVersions(gh, ref.repo, path);
    if (versions.length > 0) return new ListHistory(path, versions);
  }
  return null;
}
