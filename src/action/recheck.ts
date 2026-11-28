/**
 * Checking waiting pull requests again when the project's own trust list changes: on a push
 * to the default branch that touched the list, every open pull request labelled "unknown"
 * is checked again. Those now admitted get their label and comment updated; those still
 * unknown are left exactly as they are.
 */
import { VOUCH_FILE_CANDIDATES } from "../engine/config.ts";
import type { GitHubClient } from "../github/client.ts";
import { LIST_CHANGED, loadRules, pullRequestFromApi, runCheck, type CheckResult } from "./check.ts";

/** At most this many pull requests are checked again per push, newest first. */
export const MAX_RECHECKS = 50;

/** GitHub lists at most this many commits in a push event. */
const MAX_EVENT_COMMITS = 2048;

/** Open pull requests read while looking for labelled ones: 10 pages of 100. */
const MAX_PAGES = 10;

type PushCommit = { added?: string[]; modified?: string[]; removed?: string[] };

/** The parts of a `push` event payload this reads. */
export type PushEvent = {
  ref?: string;
  deleted?: boolean;
  size?: number;
  commits?: PushCommit[] | null;
  repository?: { default_branch?: string };
  sender?: { login?: string } | null;
};

export type RecheckResult = {
  /** `ignored`: nothing was checked; `rechecked`: the pull requests in `checks` were. */
  outcome: "ignored" | "rechecked";
  reason: string;
  checks: { number: number; result: CheckResult }[];
  /** Pull requests that could not be checked at all, with why. */
  failed: { number: number; error: string }[];
  warnings: string[];
};

export type RecheckInput = {
  repo: string;
  event: PushEvent;
  configPath: string;
  dryRun: boolean;
  max?: number;
  log?: (message: string) => void;
};

/**
 * Whether the push may have changed one of `paths`. When the event does not list every
 * commit (absent, empty or truncated), it is assumed to have.
 */
export function pushTouches(event: PushEvent, paths: string[]): boolean {
  const commits = event.commits;
  if (!Array.isArray(commits) || commits.length === 0) return true;
  if (commits.length >= MAX_EVENT_COMMITS || (typeof event.size === "number" && event.size > commits.length)) return true;
  const wanted = new Set(paths);
  return commits.some((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].some((f) => wanted.has(f)));
}

export async function handlePush(gh: GitHubClient, input: RecheckInput): Promise<RecheckResult> {
  const { repo, event, dryRun } = input;
  const log = input.log ?? (() => {});
  const max = input.max ?? MAX_RECHECKS;
  const warnings: string[] = [];
  const checks: RecheckResult["checks"] = [];
  const failed: RecheckResult["failed"] = [];
  const done = (outcome: RecheckResult["outcome"], reason: string): RecheckResult => {
    log(`Re-check: ${outcome} (${reason})`);
    return { outcome, reason, checks, failed, warnings };
  };

  if (event.deleted) return done("ignored", "the push deleted a branch");
  let base = event.repository?.default_branch;
  if (!base) base = (await gh.rest<{ default_branch?: string }>("GET", `/repos/${repo}`)).data?.default_branch;
  if (!base || event.ref !== `refs/heads/${base}`) return done("ignored", "not a push to the default branch");

  const { config } = await loadRules(gh, repo, input.configPath);
  if (!config.ownList) return done("ignored", "own_list is none, so there is no list of this project's own to watch");
  const label = config.labels.unknown;
  if (!label) return done("ignored", "the unknown label is turned off, so waiting pull requests cannot be found");
  const paths = config.ownList.path ? [config.ownList.path] : VOUCH_FILE_CANDIDATES;
  if (!pushTouches(event, paths)) return done("ignored", `the push did not change ${paths.join(" or ")}`);

  // Newest first. The pulls list needs only pull-requests: read, unlike filtering issues by label.
  const waiting: number[] = [];
  let more = false;
  for (let page = 1; page <= MAX_PAGES && !more; page++) {
    const { data } = await gh.rest<{ number?: number; labels?: { name?: string }[] }[]>(
      "GET",
      `/repos/${repo}/pulls?state=open&sort=created&direction=desc&per_page=100&page=${page}`,
    );
    const list = Array.isArray(data) ? data : [];
    for (const pull of list) {
      if (typeof pull.number !== "number" || !pull.labels?.some((l) => l.name === label)) continue;
      if (waiting.length === max) {
        more = true;
        break;
      }
      waiting.push(pull.number);
    }
    if (list.length < 100) break;
    if (page === MAX_PAGES && !more) {
      warnings.push(`Only the newest ${MAX_PAGES * 100} open pull requests were looked at for the "${label}" label.`);
    }
  }
  if (more) {
    warnings.push(`More than ${max} open pull requests are labelled "${label}"; only the newest ${max} were checked again.`);
  }
  if (waiting.length === 0) return done("rechecked", `the trust list changed, and no open pull request is labelled "${label}"`);

  const sender = typeof event.sender?.login === "string" ? event.sender.login : null;
  for (const number of waiting) {
    try {
      const { data } = await gh.rest<Record<string, unknown>>("GET", `/repos/${repo}/pulls/${number}`);
      const result = await runCheck(gh, {
        pr: pullRequestFromApi(repo, data),
        trigger: { action: LIST_CHANGED, sender },
        configPath: input.configPath,
        dryRun,
        log,
      });
      checks.push({ number, result });
    } catch (error) {
      // One pull request failing never stops the others.
      failed.push({ number, error: (error as Error).message });
      warnings.push(`Could not check #${number} again: ${(error as Error).message}`);
    }
  }

  const admitted = checks.filter((c) => c.result.status === "admitted" || c.result.status === "exempt").length;
  const errors = checks.filter((c) => c.result.status === "error").length + failed.length;
  return done(
    "rechecked",
    `the trust list changed; checked ${waiting.length} pull request${waiting.length === 1 ? "" : "s"} labelled "${label}" again: ` +
      `${admitted} now admitted${errors ? `, ${errors} failed` : ""}`,
  );
}
