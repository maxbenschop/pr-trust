import { listKey, VOUCH_FILE_CANDIDATES, type ListRef } from "../engine/config.ts";
import type { ListStatus, TrustSources } from "../engine/rules.ts";
import { EMPTY_LIST, isLogin, normalizeLogin, parseVouchFile, type VouchList } from "../engine/vouchfile.ts";
import type { GitHubClient, GraphQLClient } from "../github/client.ts";
import { countAuthorMerges, countMergedElsewhere, isoSeconds } from "../github/queries.ts";

/**
 * Reads files from the tip of a repository's default branch, never from a PR's branch,
 * so a pull request cannot change the policy that judges it.
 */
export async function readDefaultBranchFiles(
  gh: GraphQLClient,
  repo: string,
  paths: string[],
): Promise<(string | null)[]> {
  return readFilesAt(gh, repo, "HEAD", paths);
}

/** Reads files as of `ref` (a commit sha, or "HEAD" for the default branch); null where missing. */
export async function readFilesAt(
  gh: GraphQLClient,
  repo: string,
  ref: string,
  paths: string[],
): Promise<(string | null)[]> {
  const [owner, name] = repo.split("/") as [string, string];
  const fields = paths
    .map((p, i) => `f${i}: object(expression: ${JSON.stringify(`${ref}:${p}`)}) { ... on Blob { text } }`)
    .join("\n    ");
  const result = await gh.graphql<{ repository: Record<string, { text: string | null } | null> | null }>(
    `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}`,
    { owner, name },
  );
  if (!result.repository) throw new Error(`Repository ${repo} not found or not readable`);
  return paths.map((_, i) => result.repository?.[`f${i}`]?.text ?? null);
}

/** The first of `paths` that exists on the default branch. */
export async function readFirstFile(
  gh: GraphQLClient,
  repo: string,
  paths: string[],
): Promise<{ path: string; text: string } | null> {
  const texts = await readDefaultBranchFiles(gh, repo, paths);
  const index = texts.findIndex((t) => t !== null);
  return index === -1 ? null : { path: paths[index]!, text: texts[index]! };
}

/**
 * Pages of 100 of the author's merged PRs to walk when a repository is missing from the
 * search index. Five pages is at most five extra requests per `merged` rule per check.
 */
export const FALLBACK_MAX_PAGES = 5;

/**
 * Pages of 100 search results read for `merged: { repo: any }`. Only PRs merged by someone
 * else count, so more than `min` results may be needed; three pages is plenty for any sane `min`.
 */
export const ELSEWHERE_MAX_PAGES = 3;

export type LiveSources = TrustSources & {
  /** Problems worth showing the maintainer, such as an unreadable list. */
  warnings: string[];
};

/**
 * Trust facts as they stand now. Each list and search runs at most once per check.
 * `ownListText` is the project's own list as just written by `/vouch`, used instead of
 * reading it back, which might still return the version before the commit.
 */
export function liveSources(
  gh: GitHubClient,
  options: { repo: string; ownListPath: string | null; ownListText?: string | null },
): LiveSources {
  const warnings: string[] = [];
  const lists = new Map<string, Promise<VouchList>>();
  const searchable = new Map<string, Promise<boolean>>();

  /** A missing own list is normal under `own_list: auto`, so only other misses are reported. */
  const loadList = (ref: ListRef, warnIfMissing = true): Promise<VouchList> => {
    const key = listKey(ref);
    let pending = lists.get(key);
    if (!pending) {
      pending = readFirstFile(gh, ref.repo, ref.path ? [ref.path] : VOUCH_FILE_CANDIDATES).then(
        (found) => {
          if (!found) {
            if (warnIfMissing) warnings.push(`No trust list found in ${ref.repo}${ref.path ? `:${ref.path}` : ""}.`);
            return EMPTY_LIST;
          }
          return parseVouchFile(found.text);
        },
        (error: Error) => {
          warnings.push(`Could not read the trust list in ${ref.repo}: ${error.message}`);
          return EMPTY_LIST;
        },
      );
      lists.set(key, pending);
    }
    return pending;
  };

  const count = async (q: string) =>
    (await gh.graphql<{ search: { issueCount: number } }>(
      `query($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } }`,
      { q },
    )).search.issueCount;

  const isSearchable = (repo: string) => {
    let pending = searchable.get(repo);
    if (!pending) {
      pending = count(`repo:${repo} is:pr`).then((n) => n > 0);
      searchable.set(repo, pending);
    }
    return pending;
  };

  const renamed = new Set<string>();
  const names = new Map<string, Promise<string | null>>();
  /** The repository's name today (GitHub redirects old names), or null if it cannot be read. */
  const currentName = (repo: string) => {
    let pending = names.get(repo);
    if (!pending) {
      const [owner, name] = repo.split("/");
      pending = gh
        .graphql<{ repository: { nameWithOwner: string } | null }>(
          `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner } }`,
          { owner, name },
        )
        .then((r) => r.repository?.nameWithOwner ?? null, () => null);
      names.set(repo, pending);
    }
    return pending;
  };

  const memberships = new Map<string, Promise<boolean>>();
  const created = new Map<string, Promise<Date | null>>();

  return {
    warnings,
    async ownList(login): Promise<ListStatus> {
      const list =
        options.ownListText != null
          ? parseVouchFile(options.ownListText)
          : await loadList({ repo: options.repo, path: options.ownListPath }, options.ownListPath !== null);
      const key = normalizeLogin(login);
      if (list.denounced.has(key)) return "denounced";
      return list.vouched.has(key) ? "vouched" : "unknown";
    },
    async listVouches(source, login) {
      return (await loadList(source)).vouched.has(normalizeLogin(login));
    },
    async mergedCount(named, login, from, to, min) {
      if (!isLogin(login)) return 0;
      const merges = (repo: string) =>
        count(`repo:${repo} is:pr is:merged author:${login} merged:${isoSeconds(from)}..${isoSeconds(to)}`);
      let repo = named;
      let n = await merges(repo);
      if (n > 0 || (await isSearchable(repo))) return n;

      // Search does not follow renames: a repository that moved (facebook/react is now
      // react/react) finds nothing under its old name. Look up the current name and retry.
      const current = await currentName(named);
      if (current && current.toLowerCase() !== named.toLowerCase()) {
        if (!renamed.has(named)) {
          renamed.add(named);
          warnings.push(`${named} is now ${current}. The rule still works, but update it to the new name.`);
        }
        repo = current;
        n = await merges(repo);
        if (n > 0 || (await isSearchable(repo))) return n;
      }

      // Search knows nothing about this repository at all, so walk the author's own merged
      // PRs instead. A failure here only costs this rule, never the check.
      const unchecked = `${repo} is not in GitHub's search index`;
      try {
        const result = await countAuthorMerges(gh, { repo, login, from, to, min, maxPages: FALLBACK_MAX_PAGES });
        if (result === null) {
          warnings.push(`${unchecked}, and ${login}'s pull requests could not be listed, so their merge history there cannot be checked.`);
          return 0;
        }
        if (!result.complete) {
          warnings.push(
            `${unchecked}, and ${login} has more merged pull requests elsewhere than this check reads, ` +
              `so only ${result.count} merged PR${result.count === 1 ? "" : "s"} there could be confirmed.`,
          );
        }
        return result.count;
      } catch (error) {
        warnings.push(`${unchecked}, and listing ${login}'s pull requests failed (${(error as Error).message}), so their merge history there cannot be checked.`);
        return 0;
      }
    },
    async mergedElsewhereCount(login, from, to, min) {
      if (!isLogin(login)) return 0;
      try {
        const result = await countMergedElsewhere(gh, { login, from, to, min, maxPages: ELSEWHERE_MAX_PAGES });
        if (!result.complete) {
          warnings.push(
            `Search found ${result.found} pull requests by ${login} merged outside their own account, more than this ` +
              `check reads; of the first ${ELSEWHERE_MAX_PAGES * 100}, ${result.count} were merged by someone else, so that rule did not match.`,
          );
        }
        return result.count;
      } catch (error) {
        warnings.push(`Could not search ${login}'s merged pull requests elsewhere on GitHub (${(error as Error).message}), so that rule did not match.`);
        return 0;
      }
    },
    isPublicOrgMember(org, login) {
      if (!isLogin(login)) return false;
      const key = `${org.toLowerCase()}/${normalizeLogin(login)}`;
      let pending = memberships.get(key);
      if (!pending) {
        // 204: a public member. 404: not one, or a private member, or no such organisation.
        pending = gh
          .rest("GET", `/orgs/${encodeURIComponent(org)}/public_members/${encodeURIComponent(login)}`, undefined, [404])
          .then(
            (r) => r.status === 204,
            (error: Error) => {
              warnings.push(`Could not check whether ${login} is a public member of ${org} (${error.message}), so that rule did not match.`);
              return false;
            },
          );
        memberships.set(key, pending);
      }
      return pending;
    },
    accountCreatedAt(login) {
      const key = normalizeLogin(login);
      let pending = created.get(key);
      if (pending) return pending;
      pending = gh
        .graphql<{ user: { createdAt: string } | null }>(`query($login: String!) { user(login: $login) { createdAt } }`, { login })
        .then(
          (r) => (r.user ? new Date(r.user.createdAt) : null),
          (error: Error) => {
            warnings.push(`Could not read when ${login}'s account was created (${error.message}), so min_account_age did not let rules admit it.`);
            return null;
          },
        );
      created.set(key, pending);
      return pending;
    },
  };
}
