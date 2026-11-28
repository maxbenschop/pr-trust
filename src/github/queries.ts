import { RetriesExhaustedError, type GraphQLClient } from "./client.ts";

/** GitHub search returns at most 1000 results per query, so larger ranges are split. */
const SEARCH_CAP = 1000;
const MIN_SPLIT_MS = 60_000;
const MIN_PAGE_SIZE = 10;
const QUICK_ATTEMPTS = 3;

export type PullRequestRow = {
  number: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  state: "OPEN" | "CLOSED" | "MERGED";
  /** null when the account was deleted. */
  author: string | null;
  authorType: string | null;
  /** Relationship to the repo as GitHub reports it today (see docs/limitations.md). */
  association: string;
  closedBy: string | null;
  closedByType: string | null;
  changedFiles: number;
  /** null when file lists were not requested. */
  files: string[] | null;
};

export type MergedRow = { author: string; mergedAt: string; mergedBy: string | null };
export type FileVersion = { at: string; text: string | null };

export type Progress = (message: string) => void;

export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Fetches pages of `query`, injecting `first`. Heavy pages time out on busy repositories,
 * so on repeated failures it halves the page size and retries the same cursor rather than
 * waiting out long retries. The smaller size sticks for later pages.
 */
function shrinkingPager(gh: GraphQLClient, query: string, pageSize: number, onProgress?: Progress) {
  let size = pageSize;
  return async <T>(variables: Record<string, unknown>): Promise<T> => {
    for (;;) {
      const withSize = { ...variables, first: size };
      if (size <= MIN_PAGE_SIZE) return gh.graphql<T>(query, withSize);
      try {
        return await gh.graphql<T>(query, withSize, { attempts: QUICK_ATTEMPTS });
      } catch (error) {
        if (!(error instanceof RetriesExhaustedError)) throw error;
        size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
        onProgress?.(`GitHub kept timing out; asking for ${size} results per page`);
      }
    }
  };
}

type SearchResult<N> = {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (N | null)[];
  };
};

type SearchOptions = {
  /** Search qualifiers without the date range, e.g. "repo:o/r is:pr". */
  base: string;
  field: "created" | "merged";
  from: Date;
  to: Date;
  /** Selection set applied to each result node. */
  fragment: string;
  pageSize: number;
  extraVariables?: Record<string, unknown>;
  extraVariableDefs?: string;
  onProgress?: Progress;
};

/** Runs a search over [from, to], splitting the range until every piece fits under the cap. */
export async function searchAll<N>(gh: GraphQLClient, options: SearchOptions): Promise<N[]> {
  const query = `query($q: String!, $first: Int!, $after: String${options.extraVariableDefs ?? ""}) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ${options.fragment} }
  }
}`;
  const results: N[] = [];
  let truncatedRanges = 0;
  const pager = shrinkingPager(gh, query, options.pageSize, options.onProgress);
  const fetchPage = (q: string, after: string | null) =>
    pager<SearchResult<N>>({ q, after, ...options.extraVariables });

  const runRange = async (from: Date, to: Date): Promise<void> => {
    const q = `${options.base} ${options.field}:${isoSeconds(from)}..${isoSeconds(to)}`;
    let after: string | null = null;
    let first = true;
    for (;;) {
      const page: SearchResult<N> = await fetchPage(q, after);
      const { issueCount, pageInfo, nodes } = page.search;
      if (first) {
        first = false;
        const span = to.getTime() - from.getTime();
        if (issueCount > SEARCH_CAP && span > MIN_SPLIT_MS) {
          const mid = new Date(from.getTime() + Math.floor(span / 2 / 1000) * 1000);
          await runRange(from, mid);
          await runRange(new Date(mid.getTime() + 1000), to);
          return;
        }
        if (issueCount > SEARCH_CAP) truncatedRanges++;
        if (issueCount > 0) {
          options.onProgress?.(`${options.field} ${isoSeconds(from).slice(0, 10)}..${isoSeconds(to).slice(0, 10)}: ${issueCount}`);
        }
      }
      for (const node of nodes) if (node) results.push(node);
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) return;
      after = pageInfo.endCursor;
    }
  };

  await runRange(options.from, options.to);
  if (truncatedRanges > 0) {
    options.onProgress?.(`warning: ${truncatedRanges} search range(s) exceeded ${SEARCH_CAP} results and were cut off`);
  }
  return results;
}

type Connection<N> = {
  repository: {
    pullRequests: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (N | null)[] };
  } | null;
};

/**
 * Walks a repository's pull requests newest first (by `orderField`), stopping after the
 * first page that reaches past `stopBefore`. Unlike search, this has no result cap and does
 * not depend on the search index.
 */
async function scanPullRequests<N>(
  gh: GraphQLClient,
  options: {
    repo: string;
    orderField: "CREATED_AT" | "UPDATED_AT";
    states?: string;
    fragment: string;
    pageSize: number;
    /** The node's timestamp for `orderField`. */
    timeOf: (node: N) => string;
    stopBefore: Date;
    extraVariables?: Record<string, unknown>;
    extraVariableDefs?: string;
    onProgress?: Progress;
  },
): Promise<N[]> {
  const [owner, name] = options.repo.split("/") as [string, string];
  const states = options.states ? `, states: [${options.states}]` : "";
  const query = `query($owner: String!, $name: String!, $first: Int!, $after: String${options.extraVariableDefs ?? ""}) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $after${states}, orderBy: { field: ${options.orderField}, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${options.fragment} }
    }
  }
}`;
  const pager = shrinkingPager(gh, query, options.pageSize, options.onProgress);
  const stop = options.stopBefore.toISOString();
  const nodes: N[] = [];
  let after: string | null = null;
  for (let page = 1; ; page++) {
    const result: Connection<N> = await pager<Connection<N>>({ owner, name, after, ...options.extraVariables });
    if (!result.repository) throw new Error(`Repository ${options.repo} not found`);
    const { pageInfo, nodes: batch } = result.repository.pullRequests;
    let reachedEnd = false;
    for (const node of batch) {
      if (!node) continue;
      nodes.push(node);
      if (options.timeOf(node) < stop) reachedEnd = true;
    }
    if (page % 10 === 0) options.onProgress?.(`${nodes.length} PRs scanned`);
    if (reachedEnd || !pageInfo.hasNextPage || !pageInfo.endCursor) return nodes;
    after = pageInfo.endCursor;
  }
}

type RawPullRequest = {
  number: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  state: PullRequestRow["state"];
  authorAssociation: string;
  changedFiles: number;
  author: { login: string; __typename: string } | null;
  timelineItems: { nodes: ({ actor: { login: string; __typename: string } | null } | null)[] };
  files?: { nodes: { path: string }[] } | null;
};

const PULL_REQUEST_FRAGMENT = `
  number createdAt mergedAt closedAt state authorAssociation changedFiles
  author { login __typename }
  timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
    nodes { ... on ClosedEvent { actor { login __typename } } }
  }
  files(first: 100) @include(if: $withFiles) { nodes { path } }
`;

/** Every PR opened against `repo` in [from, to]. */
export async function fetchPullRequests(
  gh: GraphQLClient,
  repo: string,
  from: Date,
  to: Date,
  options: { withFiles: boolean; onProgress?: Progress },
): Promise<PullRequestRow[]> {
  const scanned = await scanPullRequests<RawPullRequest>(gh, {
    repo,
    orderField: "CREATED_AT",
    fragment: PULL_REQUEST_FRAGMENT,
    pageSize: options.withFiles ? 25 : 50,
    timeOf: (pr) => pr.createdAt,
    stopBefore: from,
    extraVariables: { withFiles: options.withFiles },
    extraVariableDefs: ", $withFiles: Boolean!",
    onProgress: options.onProgress,
  });
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const raw = scanned.filter((pr) => pr.createdAt >= fromIso && pr.createdAt <= toIso);

  const byNumber = new Map<number, PullRequestRow>();
  for (const pr of raw) {
    if (typeof pr.number !== "number") continue;
    const closer = pr.timelineItems.nodes.at(-1)?.actor ?? null;
    byNumber.set(pr.number, {
      number: pr.number,
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      state: pr.state,
      author: pr.author?.login ?? null,
      authorType: pr.author?.__typename ?? null,
      association: pr.authorAssociation,
      closedBy: closer?.login ?? null,
      closedByType: closer?.__typename ?? null,
      changedFiles: pr.changedFiles,
      files: pr.files ? pr.files.nodes.map((f) => f.path) : null,
    });
  }
  return [...byNumber.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Author and merge time of every PR merged into `repo` in [from, to]. */
export async function fetchMerged(
  gh: GraphQLClient,
  repo: string,
  from: Date,
  to: Date,
  onProgress?: Progress,
): Promise<MergedRow[]> {
  type Raw = {
    number: number;
    mergedAt: string | null;
    updatedAt?: string;
    author: { login: string } | null;
    mergedBy: { login: string } | null;
  };
  const fields = "number mergedAt author { login } mergedBy { login }";
  let raw = await searchAll<Raw>(gh, {
    base: `repo:${repo} is:pr is:merged`,
    field: "merged",
    from,
    to,
    fragment: `... on PullRequest { ${fields} }`,
    pageSize: 100,
    onProgress,
  });

  // Some repositories cannot be found by search (a renamed one under its old name, for one), and
  // search then reports nothing at all. Fall back to walking the repository's merged PRs.
  if (raw.length === 0) {
    onProgress?.("search returned nothing; listing merged PRs from the repository instead");
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    raw = (
      await scanPullRequests<Raw>(gh, {
        repo,
        orderField: "UPDATED_AT",
        states: "MERGED",
        fragment: `${fields} updatedAt`,
        pageSize: 100,
        // A PR's updatedAt is never earlier than its mergedAt.
        timeOf: (pr) => pr.updatedAt ?? "",
        stopBefore: from,
        onProgress,
      })
    ).filter((pr) => pr.mergedAt !== null && pr.mergedAt >= fromIso && pr.mergedAt <= toIso);
  }
  const seen = new Set<number>();
  const rows: MergedRow[] = [];
  for (const pr of raw) {
    if (!pr.author || !pr.mergedAt || seen.has(pr.number)) continue;
    seen.add(pr.number);
    rows.push({ author: pr.author.login, mergedAt: pr.mergedAt, mergedBy: pr.mergedBy?.login ?? null });
  }
  return rows;
}

export type AuthorMergeCount = {
  count: number;
  /** False when the page cap was hit before the answer was known; `count` is then a lower bound. */
  complete: boolean;
};

/**
 * Counts `login`'s PRs merged into `repo` in [from, to) by walking the author's own merged
 * PRs, most recently updated first, instead of searching. This works for repositories that
 * are missing from the search index, and costs one request per 100 of the author's merged
 * PRs (in any repository) updated since `from`. It stops once `min` is reached, once it is
 * past `from`, or after `maxPages` pages. Returns null when there is no such user.
 */
export async function countAuthorMerges(
  gh: GraphQLClient,
  options: { repo: string; login: string; from: Date; to: Date; min: number; maxPages: number },
): Promise<AuthorMergeCount | null> {
  type Page = {
    user: {
      pullRequests: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ({ number: number; mergedAt: string | null; updatedAt: string; repository: { nameWithOwner: string } } | null)[];
      };
    } | null;
  };
  const query = `query($login: String!, $after: String) {
  user(login: $login) {
    pullRequests(first: 100, after: $after, states: [MERGED], orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number mergedAt updatedAt repository { nameWithOwner } }
    }
  }
}`;
  const repo = options.repo.toLowerCase();
  const fromIso = options.from.toISOString();
  const toIso = options.to.toISOString();
  const seen = new Set<number>();
  let after: string | null = null;
  for (let page = 1; page <= options.maxPages; page++) {
    const result: Page = await gh.graphql<Page>(query, { login: options.login, after });
    if (!result.user) return null;
    const { pageInfo, nodes } = result.user.pullRequests;
    let pastStart = false;
    for (const pr of nodes) {
      if (!pr) continue;
      // A PR's updatedAt is never earlier than its mergedAt, so nothing after this merged in the window.
      if (pr.updatedAt < fromIso) {
        pastStart = true;
        break;
      }
      if (pr.repository.nameWithOwner.toLowerCase() !== repo || !pr.mergedAt) continue;
      if (pr.mergedAt < fromIso || pr.mergedAt >= toIso) continue;
      seen.add(pr.number);
      if (seen.size >= options.min) return { count: seen.size, complete: true };
    }
    if (pastStart || !pageInfo.hasNextPage || !pageInfo.endCursor) return { count: seen.size, complete: true };
    after = pageInfo.endCursor;
  }
  return { count: seen.size, complete: false };
}

/**
 * The search for `login`'s PRs merged in [from, to] into public repositories `login` does not
 * own. `-user:` leaves out repositories under the author's own account; organisations they
 * control are still searched, which is why callers also drop PRs the author merged themselves.
 */
export function mergedElsewhereQuery(login: string, from: Date, to: Date): string {
  return `is:pr is:merged is:public author:${login} -user:${login} merged:${isoSeconds(from)}..${isoSeconds(to)}`;
}

/** A PR from that search, as needed to judge whether it counts. */
export type ElsewhereMerge = { mergedAt: string; mergedBy: string | null; owner: string };

export const ELSEWHERE_FRAGMENT = "... on PullRequest { mergedAt mergedBy { login } repository { owner { login } } }";

type RawElsewhere = { mergedAt: string | null; mergedBy: { login: string } | null; repository: { owner: { login: string } } | null };

export function toElsewhereMerge(node: RawElsewhere): ElsewhereMerge | null {
  if (!node.mergedAt || !node.repository) return null;
  return { mergedAt: node.mergedAt, mergedBy: node.mergedBy?.login ?? null, owner: node.repository.owner.login };
}

/**
 * Whether a merge outside the author's own repositories counts: someone else merged it, into
 * a repository someone else owns. A merger that no longer exists (null) still counts.
 */
export function countsAsElsewhere(merge: ElsewhereMerge, login: string): boolean {
  const me = login.toLowerCase();
  return merge.owner.toLowerCase() !== me && merge.mergedBy?.toLowerCase() !== me;
}

/**
 * Counts `login`'s PRs merged in [from, to) into others' public repositories and merged by
 * someone else. One search request per 100 results; stops at `min`, once the results left
 * cannot reach it, or after `maxPages`. `found` is how many results search reported.
 */
export async function countMergedElsewhere(
  gh: GraphQLClient,
  options: { login: string; from: Date; to: Date; min: number; maxPages: number },
): Promise<AuthorMergeCount & { found: number }> {
  const query = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ${ELSEWHERE_FRAGMENT} }
  }
}`;
  const q = mergedElsewhereQuery(options.login, options.from, options.to);
  const toIso = options.to.toISOString();
  let count = 0;
  let read = 0;
  let found = 0;
  let after: string | null = null;
  for (let page = 1; page <= options.maxPages; page++) {
    const result: SearchResult<RawElsewhere> = await gh.graphql<SearchResult<RawElsewhere>>(query, { q, after });
    const { issueCount, pageInfo, nodes } = result.search;
    found = issueCount;
    for (const node of nodes) {
      read++;
      const merge = node ? toElsewhereMerge(node) : null;
      // Search ranges include their end; the window does not.
      if (!merge || merge.mergedAt >= toIso || !countsAsElsewhere(merge, options.login)) continue;
      if (++count >= options.min) return { count, complete: true, found };
    }
    const unread = Math.max(0, issueCount - read);
    if (count + unread < options.min || !pageInfo.hasNextPage || !pageInfo.endCursor) return { count, complete: true, found };
    after = pageInfo.endCursor;
  }
  return { count, complete: false, found };
}

/** Every one of `login`'s merges that `countsAsElsewhere`, in [from, to], for the backtest. */
export async function fetchMergedElsewhere(
  gh: GraphQLClient,
  login: string,
  from: Date,
  to: Date,
  onProgress?: Progress,
): Promise<string[]> {
  const raw = await searchAll<RawElsewhere>(gh, {
    base: `is:pr is:merged is:public author:${login} -user:${login}`,
    field: "merged",
    from,
    to,
    fragment: ELSEWHERE_FRAGMENT,
    pageSize: 100,
    onProgress,
  });
  return raw
    .map(toElsewhereMerge)
    .filter((m): m is ElsewhereMerge => m !== null && countsAsElsewhere(m, login))
    .map((m) => m.mergedAt);
}

/** Account creation times for `logins`, 50 per request; logins that are not users are left out. */
export async function fetchAccountCreation(gh: GraphQLClient, logins: string[]): Promise<Map<string, string>> {
  const created = new Map<string, string>();
  const BATCH = 50;
  for (let i = 0; i < logins.length; i += BATCH) {
    const batch = logins.slice(i, i + BATCH);
    const fields = batch.map((login, j) => `u${j}: user(login: ${JSON.stringify(login)}) { createdAt }`).join("\n  ");
    let result: Record<string, { createdAt: string } | null>;
    try {
      result = await gh.graphql<Record<string, { createdAt: string } | null>>(`query {\n  ${fields}\n}`);
    } catch (error) {
      // A login that is not a user fails the whole batch ("Could not resolve to a User");
      // fall back to one at a time so the rest still resolve.
      if (!/could not resolve/i.test((error as Error).message)) throw error;
      if (batch.length > 1) {
        for (const login of batch) for (const [k, v] of await fetchAccountCreation(gh, [login])) created.set(k, v);
      }
      continue;
    }
    batch.forEach((login, j) => {
      const user = result[`u${j}`];
      if (user) created.set(login.toLowerCase(), user.createdAt);
    });
  }
  return created;
}

/**
 * Every version of one file on the default branch, oldest first. A version with
 * `text: null` means the file did not exist (or was deleted) at that commit.
 */
export async function fetchFileVersions(gh: GraphQLClient, repo: string, path: string): Promise<FileVersion[]> {
  const [owner, name] = repo.split("/") as [string, string];
  type History = {
    repository: {
      defaultBranchRef: {
        target: {
          history?: {
            nodes: { oid: string; committedDate: string }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      } | null;
    } | null;
  };
  const historyQuery = `query($owner: String!, $name: String!, $path: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit {
      history(path: $path, first: 100, after: $after) {
        nodes { oid committedDate }
        pageInfo { hasNextPage endCursor }
      }
    } } }
  }
}`;

  const commits: { oid: string; committedDate: string }[] = [];
  let after: string | null = null;
  for (;;) {
    const result: History = await gh.graphql<History>(historyQuery, { owner, name, path, after });
    const history = result.repository?.defaultBranchRef?.target.history;
    if (!history) break;
    commits.push(...history.nodes);
    if (!history.pageInfo.hasNextPage || !history.pageInfo.endCursor) break;
    after = history.pageInfo.endCursor;
  }
  if (commits.length === 0) return [];

  const versions: FileVersion[] = [];
  const BATCH = 25;
  for (let i = 0; i < commits.length; i += BATCH) {
    const batch = commits.slice(i, i + BATCH);
    const fields = batch
      .map((c, j) => `f${j}: object(expression: ${JSON.stringify(`${c.oid}:${path}`)}) { ... on Blob { text } }`)
      .join("\n    ");
    const blobQuery = `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}`;
    const result = await gh.graphql<{ repository: Record<string, { text: string | null } | null> }>(blobQuery, { owner, name });
    batch.forEach((c, j) => {
      versions.push({ at: c.committedDate, text: result.repository[`f${j}`]?.text ?? null });
    });
  }
  return versions.sort((a, b) => a.at.localeCompare(b.at));
}
