import type { TrustConfig } from "../engine/config.ts";
import { evaluate, type Decision, type TrustSources } from "../engine/rules.ts";
import type { PullRequestRow } from "../github/queries.ts";

/** Who opened the PR. Only "external" PRs would ever meet the gate. */
export type Group = "maintainer" | "bot" | "deleted" | "external";

/**
 * What happened to the PR.
 * - rejected: closed by someone other than the author
 * - withdrawn: closed by the author
 * - auto_closed: closed by a bot (an existing gate, a stale bot, ...)
 */
export type Outcome = "merged" | "rejected" | "withdrawn" | "auto_closed" | "open";

export type ReplayRow = {
  pr: PullRequestRow;
  group: Group;
  outcome: Outcome;
  /** Only set for external PRs. */
  decision: Decision | null;
};

/**
 * Associations that skip the gate, mirroring Vouch's "collaborators are allowed".
 * Not enough on its own: GitHub reports private org members as CONTRIBUTOR to outsiders,
 * so callers also pass logins seen merging or closing other people's PRs.
 */
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * GitHub Apps, plus user accounts that run automation under a name ending in "bot"
 * (zaniebot, divybot). The second part is a guess and can catch a human login.
 */
export function isBot(login: string | null, type: string | null): boolean {
  return type === "Bot" || /(bot|\[bot\])$/i.test(login ?? "");
}

export function groupOf(pr: PullRequestRow, maintainers: ReadonlySet<string> = new Set()): Group {
  if (!pr.author || pr.authorType === "Mannequin") return "deleted";
  if (isBot(pr.author, pr.authorType)) return "bot";
  if (MAINTAINER_ASSOCIATIONS.has(pr.association) || maintainers.has(pr.author.toLowerCase())) return "maintainer";
  return "external";
}

export function outcomeOf(pr: PullRequestRow): Outcome {
  if (pr.mergedAt) return "merged";
  if (pr.state === "OPEN") return "open";
  if (isBot(pr.closedBy, pr.closedByType)) return "auto_closed";
  if (pr.closedBy && pr.author && pr.closedBy.toLowerCase() === pr.author.toLowerCase()) return "withdrawn";
  return "rejected";
}

export async function replay(
  prs: PullRequestRow[],
  config: TrustConfig,
  sources: TrustSources,
  repo: string,
  maintainers: ReadonlySet<string> = new Set(),
): Promise<ReplayRow[]> {
  const rows: ReplayRow[] = [];
  for (const pr of prs) {
    const group = groupOf(pr, maintainers);
    const outcome = outcomeOf(pr);
    if (group !== "external") {
      rows.push({ pr, group, outcome, decision: null });
      continue;
    }
    const complete = pr.files !== null && pr.files.length >= pr.changedFiles;
    const decision = await evaluate(
      {
        config,
        repo,
        login: pr.author as string,
        at: new Date(pr.createdAt),
        changedPaths: complete ? pr.files : null,
      },
      sources,
    );
    rows.push({ pr, group, outcome, decision });
  }
  return rows;
}
