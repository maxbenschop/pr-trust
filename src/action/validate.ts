import { ANY, SELF, VOUCH_FILE_CANDIDATES, didYouMean, type TrustConfig } from "../engine/config.ts";
import { createLocator, lintConfig, type Finding, type Problem } from "../engine/lint.ts";
import { parseVouchFile } from "../engine/vouchfile.ts";
import type { GraphQLClient } from "../github/client.ts";
import { readFilesAt } from "./live.ts";

/**
 * `pr-trust validate` and the Action's `validate` input: the offline checks of
 * src/engine/lint.ts, then optionally checks against GitHub. The rules file is only ever
 * parsed as data; nothing in it is run.
 */

export type OnlineOptions = {
  gh: GraphQLClient;
  /** The repository the rules are for: resolves `self`, and holds own_list and message_file. Null skips those. */
  repo: string | null;
  /** Where to look for own_list and message_file: "HEAD" (the default branch) or a commit sha. */
  ref?: string;
  /** Where `ref` is, for messages: "on the default branch", "in this pull request". */
  refName?: string;
};

export type ValidationResult = {
  findings: Finding[];
  /** Things that were not checked, for the reader; never a problem in the file. */
  notes: string[];
  online: boolean;
};

export async function validateRules(text: string, online?: OnlineOptions): Promise<ValidationResult> {
  const { config, findings } = lintConfig(text);
  const notes: string[] = [];
  if (config && online) {
    const locate = createLocator(text);
    const result = await onlineProblems(config, online);
    findings.push(...result.problems.map((p) => ({ ...p, line: locate(p.path) })));
    notes.push(...result.notes);
  } else if (!config && online) {
    notes.push("The online checks run once the errors above are fixed.");
  }
  findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { findings, notes, online: online !== undefined };
}

/** The placeholders a message_file may use (see renderMessage in check.ts). */
export const MESSAGE_PLACEHOLDERS = ["author", "reason", "repo", "next", "rules", "alert"];

export async function onlineProblems(
  config: TrustConfig,
  options: OnlineOptions,
): Promise<{ problems: Problem[]; notes: string[] }> {
  const { gh, repo } = options;
  const ref = options.ref ?? "HEAD";
  const refName = options.refName ?? (ref === "HEAD" ? "on the default branch" : `at ${ref}`);
  const problems: Problem[] = [];
  const notes: string[] = [];
  const error = (path: Problem["path"], message: string) => problems.push({ level: "error", message, path });
  const warn = (path: Problem["path"], message: string) => problems.push({ level: "warning", message, path });

  const names = new Map<string, Promise<string | null>>();
  /** The repository's current name (GitHub follows renames here), or null if it does not exist. */
  const currentName = (name: string) => {
    const key = name.toLowerCase();
    let pending = names.get(key);
    if (!pending) {
      const [owner, short] = name.split("/");
      pending = gh
        .graphql<{ repository: { nameWithOwner: string } | null }>(
          `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner } }`,
          { owner, name: short },
        )
        .then(
          (r) => r.repository?.nameWithOwner ?? null,
          (e: Error) => {
            if (/could not resolve to a repository/i.test(e.message)) return null;
            throw e;
          },
        );
      names.set(key, pending);
    }
    return pending;
  };
  const missing = (name: string) => `${name} does not exist, or this token cannot read it`;
  const renamedTo = (name: string, current: string | null) =>
    current !== null && current.toLowerCase() !== name.toLowerCase() ? current : null;

  const searchable = new Map<string, Promise<boolean>>();
  const isSearchable = (name: string) => {
    let pending = searchable.get(name.toLowerCase());
    if (!pending) {
      pending = gh
        .graphql<{ search: { issueCount: number } }>(
          `query($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } }`,
          { q: `repo:${name} is:pr` },
        )
        .then((r) => r.search.issueCount > 0);
      searchable.set(name.toLowerCase(), pending);
    }
    return pending;
  };

  const home = repo === null ? null : await currentName(repo);
  if (repo !== null && home === null) {
    error([], `${missing(repo)}, so its own list, message file and merged rules on "self" were not checked`);
  }
  if (repo === null) {
    notes.push('No repository given, so merged rules on "self", own_list and message_file were not checked online.');
  }

  for (const [i, rule] of config.admit.entries()) {
    if (rule.kind === "list") {
      const path = ["admit", i, "list"];
      const named = rule.source.repo;
      const current = await currentName(named);
      if (current === null) {
        error(path, `${missing(named)}, so admit[${i}] admits no one`);
        continue;
      }
      const moved = renamedTo(named, current);
      if (moved) {
        warn(path, `${named} is now ${moved}. The rule still works, but update it to "list: ${moved}${rule.source.path ? `:${rule.source.path}` : ""}"`);
      }
      const candidates = rule.source.path ? [rule.source.path] : VOUCH_FILE_CANDIDATES;
      const texts = await readFilesAt(gh, current, "HEAD", candidates);
      const found = texts.find((t) => t !== null);
      if (found == null) {
        error(path, `${current} has no Vouch list at ${candidates.join(" or ")} on its default branch, so admit[${i}] admits no one`);
      } else if (parseVouchFile(found).vouched.size === 0) {
        warn(path, `the Vouch list in ${current} vouches for no one yet, so admit[${i}] admits no one for now`);
      }
      continue;
    }

    if (rule.kind === "org_member") {
      const found = await gh
        .graphql<{ organization: { login: string } | null }>(`query($login: String!) { organization(login: $login) { login } }`, {
          login: rule.org,
        })
        .then(
          (r) => r.organization !== null,
          (e: Error) => {
            if (/could not resolve to an organization/i.test(e.message)) return false;
            throw e;
          },
        );
      if (!found) error(["admit", i, "org_member"], `${rule.org} is not a GitHub organisation, so admit[${i}] admits no one`);
      continue;
    }

    const path = ["admit", i, "merged", "repo"];
    if (rule.repo === ANY) continue;
    if (rule.repo === SELF) {
      if (home && !(await isSearchable(home))) warn(path, notSearchable(home));
      continue;
    }
    const current = await currentName(rule.repo);
    if (current === null) {
      error(path, `${missing(rule.repo)}, so admit[${i}] admits no one`);
      continue;
    }
    const moved = renamedTo(rule.repo, current);
    if (moved) {
      warn(path, `${rule.repo} is now ${moved}. GitHub search does not follow renames, so the Action looks up the new name on every check; update the rule to "repo: ${moved}"`);
    }
    if (!(await isSearchable(current))) warn(path, notSearchable(current));
  }

  if (home !== null) {
    const ownPaths = config.ownList ? (config.ownList.path ? [config.ownList.path] : VOUCH_FILE_CANDIDATES) : [];
    const paths = [...ownPaths, ...(config.messageFile ? [config.messageFile] : [])];
    const texts = paths.length > 0 ? await readFilesAt(gh, home, ref, paths) : [];
    const ownText = texts.slice(0, ownPaths.length).find((t) => t !== null) ?? null;
    if (config.ownList?.path && ownText === null) {
      warn(
        ["own_list"],
        `${config.ownList.path} does not exist in ${home} ${refName}. Until it does, every check warns that the ` +
          `list is missing (the first /vouch creates it)`,
      );
    }
    if (config.messageFile) {
      const message = texts[ownPaths.length] ?? null;
      if (message === null) {
        warn(["message_file"], `${config.messageFile} does not exist in ${home} ${refName}, so the default message is used`);
      } else {
        const unknown = [...new Set([...message.matchAll(/\{([A-Za-z_]+)\}/g)].map((m) => m[1]!))].filter(
          (name) => !MESSAGE_PLACEHOLDERS.includes(name),
        );
        for (const name of unknown) {
          warn(
            ["message_file"],
            `${config.messageFile} uses {${name}}, which is not a placeholder and is shown as written` +
              `${didYouMean(name, MESSAGE_PLACEHOLDERS).replace(/"(\w+)"/, "{$1}")}. ` +
              `Placeholders: ${MESSAGE_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`,
          );
        }
      }
    }
  }

  return { problems, notes };
}

function notSearchable(repo: string): string {
  return (
    `${repo} is not in GitHub's search index, so the Action counts each author's own merged pull requests ` +
    `instead, reading at most 500 per author, which is slower and can miss merges by very active authors`
  );
}
