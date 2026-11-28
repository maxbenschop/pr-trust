import { ANY, listKey, SELF, VOUCH_FILE_CANDIDATES, type ListRef, type TrustConfig } from "../engine/config.ts";
import { subtractDuration } from "../engine/duration.ts";
import { normalizeLogin } from "../engine/vouchfile.ts";
import type { GitHubClient, GraphQLClient } from "../github/client.ts";
import {
  fetchAccountCreation,
  fetchFileVersions,
  fetchMerged,
  fetchMergedElsewhere,
  fetchPullRequests,
  type MergedRow,
  type Progress,
  type PullRequestRow,
} from "../github/queries.ts";
import { ListHistory, MergeIndex, type HistoricalData } from "./history.ts";
import { groupOf } from "./replay.ts";

export type BacktestData = HistoricalData & {
  prs: PullRequestRow[];
  /** Logins seen acting with repo permissions: merging PRs or closing other people's. */
  maintainers: Set<string>;
  notes: string[];
};

export async function loadBacktestData(
  gh: GitHubClient,
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

  // The rules below are about the author rather than a repository, so they are loaded per
  // external author: only their PRs are ever judged.
  const authors = [...new Set(prs.filter((pr) => groupOf(pr, maintainers) === "external").map((pr) => normalizeLogin(pr.author!)))];
  const extra = await loadAuthorFacts(gh, { config, authors, from, to, log, notes });
  return { prs, maintainers, own, lists, merges, ...extra, notes };
}

export async function loadAuthorFacts(
  gh: GitHubClient,
  input: { config: TrustConfig; authors: string[]; from: Date; to: Date; log: Progress; notes: string[] },
): Promise<Pick<HistoricalData, "elsewhere" | "orgMembers" | "accountCreated">> {
  const { config, authors, from, to, log, notes } = input;
  const result: Pick<HistoricalData, "elsewhere" | "orgMembers" | "accountCreated"> = {};

  const anyStarts = config.admit.flatMap((rule) =>
    rule.kind === "merged" && rule.repo === ANY ? [subtractDuration(from, rule.within).getTime()] : [],
  );
  if (anyStarts.length > 0) {
    const start = new Date(Math.min(...anyStarts));
    log(`searching merged PRs outside their own repositories for ${authors.length} authors since ${start.toISOString().slice(0, 10)}`);
    const rows: MergedRow[] = [];
    let failed = 0;
    for (const [i, login] of authors.entries()) {
      if ((i + 1) % 25 === 0) log(`  ${i + 1} of ${authors.length} authors`);
      try {
        for (const mergedAt of await fetchMergedElsewhere(gh, login, start, to)) rows.push({ author: login, mergedAt, mergedBy: null });
      } catch (error) {
        failed++;
        log(`  ${login}: ${(error as Error).message}`);
      }
    }
    result.elsewhere = new MergeIndex(rows);
    if (failed > 0) notes.push(`Merges elsewhere could not be searched for ${failed} author(s); for them "any" rules never matched.`);
    notes.push(
      'merged: { repo: any } reads GitHub search today: merges in repositories since deleted or made private are ' +
        "missed, and repository owners are today's.",
    );
  }

  const orgs = [...new Set(config.admit.flatMap((rule) => (rule.kind === "org_member" ? [rule.org.toLowerCase()] : [])))];
  if (orgs.length > 0) {
    result.orgMembers = new Map();
    for (const org of orgs) {
      log(`checking public membership of ${org} for ${authors.length} authors`);
      const members = new Set<string>();
      for (const login of authors) {
        const { status } = await gh.rest("GET", `/orgs/${encodeURIComponent(org)}/public_members/${encodeURIComponent(login)}`, undefined, [404]);
        if (status === 204) members.add(login);
      }
      result.orgMembers.set(org, members);
    }
    notes.push(
      `org_member uses today's public membership of ${orgs.join(", ")} for every PR: GitHub keeps no membership ` +
        "history, so someone who joined after opening a PR counts as a member when they opened it.",
    );
  }

  if (config.minAccountAge) {
    log(`reading account creation dates for ${authors.length} authors`);
    result.accountCreated = await fetchAccountCreation(gh, authors);
  }
  return result;
}

export async function loadList(gh: GraphQLClient, ref: ListRef, log: Progress): Promise<ListHistory | null> {
  const candidates = ref.path ? [ref.path] : VOUCH_FILE_CANDIDATES;
  for (const path of candidates) {
    log(`fetching history of ${ref.repo}:${path}`);
    const versions = await fetchFileVersions(gh, ref.repo, path);
    if (versions.length > 0) return new ListHistory(path, versions);
  }
  return null;
}
