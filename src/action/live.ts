import { listKey, VOUCH_FILE_CANDIDATES, type ListRef } from "../engine/config.ts";
import type { ListStatus, TrustSources } from "../engine/rules.ts";
import { EMPTY_LIST, normalizeLogin, parseVouchFile, type VouchList } from "../engine/vouchfile.ts";
import type { GraphQLClient } from "../github/client.ts";
import { isoSeconds } from "../github/queries.ts";

/**
 * Reads files from the tip of a repository's default branch, never from a PR's branch,
 * so a pull request cannot change the policy that judges it.
 */
export async function readDefaultBranchFiles(
  gh: GraphQLClient,
  repo: string,
  paths: string[],
): Promise<(string | null)[]> {
  const [owner, name] = repo.split("/") as [string, string];
  const fields = paths
    .map((p, i) => `f${i}: object(expression: ${JSON.stringify(`HEAD:${p}`)}) { ... on Blob { text } }`)
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

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type LiveSources = TrustSources & {
  /** Problems worth showing the maintainer, such as an unreadable list. */
  warnings: string[];
};

/** Trust facts as they stand now. Each list and search runs at most once per check. */
export function liveSources(gh: GraphQLClient, options: { repo: string; ownListPath: string | null }): LiveSources {
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

  return {
    warnings,
    async ownList(login): Promise<ListStatus> {
      const list = await loadList({ repo: options.repo, path: options.ownListPath }, options.ownListPath !== null);
      const key = normalizeLogin(login);
      if (list.denounced.has(key)) return "denounced";
      return list.vouched.has(key) ? "vouched" : "unknown";
    },
    async listVouches(source, login) {
      return (await loadList(source)).vouched.has(normalizeLogin(login));
    },
    async mergedCount(repo, login, from, to) {
      if (!LOGIN.test(login)) return 0;
      const n = await count(`repo:${repo} is:pr is:merged author:${login} merged:${isoSeconds(from)}..${isoSeconds(to)}`);
      if (n === 0 && !(await isSearchable(repo))) {
        warnings.push(`${repo} is not in GitHub's search index, so its merge history cannot be checked.`);
      }
      return n;
    },
  };
}
