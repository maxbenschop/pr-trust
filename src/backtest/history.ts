import { listKey, type ListRef } from "../engine/config.ts";
import type { ListStatus, TrustSources } from "../engine/rules.ts";
import { normalizeLogin, parseVouchFile, type VouchList } from "../engine/vouchfile.ts";
import type { FileVersion, MergedRow } from "../github/queries.ts";

/** A trust list as it stood at any point in time. */
export class ListHistory {
  readonly path: string;
  private readonly times: number[];
  private readonly lists: (VouchList | null)[];

  constructor(path: string, versions: FileVersion[]) {
    this.path = path;
    const sorted = [...versions].sort((a, b) => a.at.localeCompare(b.at));
    this.times = sorted.map((v) => Date.parse(v.at));
    this.lists = sorted.map((v) => (v.text === null ? null : parseVouchFile(v.text)));
  }

  get versionCount(): number {
    return this.times.length;
  }

  /** The list in effect at `at`, or null if the file did not exist yet. */
  at(at: Date): VouchList | null {
    const index = lastAtOrBefore(this.times, at.getTime());
    return index === -1 ? null : (this.lists[index] ?? null);
  }

  status(login: string, at: Date): ListStatus {
    const list = this.at(at);
    if (!list) return "unknown";
    const key = normalizeLogin(login);
    if (list.denounced.has(key)) return "denounced";
    return list.vouched.has(key) ? "vouched" : "unknown";
  }
}

/** Merge times per author for one repository. */
export class MergeIndex {
  private readonly byAuthor = new Map<string, number[]>();

  constructor(rows: MergedRow[]) {
    for (const row of rows) {
      const key = normalizeLogin(row.author);
      const times = this.byAuthor.get(key) ?? [];
      times.push(Date.parse(row.mergedAt));
      this.byAuthor.set(key, times);
    }
    for (const times of this.byAuthor.values()) times.sort((a, b) => a - b);
  }

  /** Merges in [from, to). */
  count(login: string, from: Date, to: Date): number {
    const times = this.byAuthor.get(normalizeLogin(login));
    if (!times) return 0;
    return lowerBound(times, to.getTime()) - lowerBound(times, from.getTime());
  }
}

export type HistoricalData = {
  own: ListHistory | null;
  lists: Map<string, ListHistory | null>;
  merges: Map<string, MergeIndex>;
};

export function historicalSources(data: HistoricalData): TrustSources {
  return {
    ownList: (login, at) => data.own?.status(login, at) ?? "unknown",
    listVouches: (source: ListRef, login, at) => data.lists.get(listKey(source))?.status(login, at) === "vouched",
    mergedCount: (repo, login, from, to) => {
      const index = data.merges.get(repo.toLowerCase());
      if (!index) throw new Error(`No merge history loaded for ${repo}`);
      return index.count(login, from, to);
    },
  };
}

/** Index of the first element >= value. */
function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the last element <= value, or -1. */
function lastAtOrBefore(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
