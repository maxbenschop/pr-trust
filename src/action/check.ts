import { DEFAULT_CONFIG_YAML, DEFAULT_LABELS, parseConfig, SELF, type Labels, type TrustConfig } from "../engine/config.ts";
import { formatDuration } from "../engine/duration.ts";
import { evaluate, type Decision } from "../engine/rules.ts";
import { isLogin } from "../engine/vouchfile.ts";
import type { GitHubClient } from "../github/client.ts";
import { liveSources, readFirstFile } from "./live.ts";

export const COMMENT_MARKER = "<!-- pr-trust -->";

export type PullRequestInfo = {
  repo: string;
  number: number;
  author: string | null;
  authorType: string | null;
  association: string;
  state: string;
  labels: string[];
  changedFiles: number;
};

/** The event that started the check: used to respect a maintainer reopening a PR. */
export type Trigger = { action: string | null; sender: string | null };

export type Status = Decision["status"] | "skipped" | "error";

export type PlannedAction =
  | { kind: "add-label"; label: string; color: string; description: string }
  | { kind: "remove-label"; label: string }
  /** Creates or updates this check's comment. */
  | { kind: "comment"; body: string }
  /** Updates this check's comment only if one already exists. */
  | { kind: "update-comment"; body: string }
  | { kind: "close" };

export type CheckResult = {
  status: Status;
  reason: string;
  rule: string | null;
  actions: PlannedAction[];
  warnings: string[];
  /** Where the rules came from. */
  configSource: string;
  applied: boolean;
};

export type CheckInput = {
  pr: PullRequestInfo;
  trigger: Trigger;
  configPath: string;
  /** Rules to use instead of the repository's file (used by the CLI). */
  configText?: string | null;
  dryRun: boolean;
  /** The project's own list as just written by `/vouch`; read from the default branch if absent. */
  ownListText?: string | null;
  now?: Date;
  log?: (message: string) => void;
};

export const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function pullRequestFromApi(repo: string, pr: Record<string, any>): PullRequestInfo {
  return {
    repo,
    number: Number(pr.number),
    author: pr.user?.login ?? null,
    authorType: pr.user?.type ?? null,
    association: String(pr.author_association ?? "NONE"),
    state: String(pr.state ?? "open"),
    labels: Array.isArray(pr.labels) ? pr.labels.map((l: { name: string }) => l.name) : [],
    changedFiles: Number(pr.changed_files ?? 0),
  };
}

export function isBotAccount(login: string, type: string | null): boolean {
  return type === "Bot" || /\[bot\]$/i.test(login);
}

/**
 * For trying rules out: treat the pull request as if `login` had opened it, as an outside
 * contributor. The real author's write access and bot status no longer apply.
 */
export function asAuthor(pr: PullRequestInfo, login: string): PullRequestInfo {
  const name = login.trim().replace(/^@/, "");
  if (!isLogin(name)) throw new Error(`as-author must be a GitHub username, got "${login}"`);
  return { ...pr, author: name, authorType: "User", association: "NONE" };
}

export async function runCheck(gh: GitHubClient, input: CheckInput): Promise<CheckResult> {
  const { pr, dryRun } = input;
  const log = input.log ?? (() => {});
  const warnings: string[] = [];
  let config: TrustConfig | null = null;
  let configSource = "not loaded";

  const skipped = (reason: string): CheckResult => ({
    status: "skipped",
    reason,
    rule: null,
    actions: [],
    warnings,
    configSource,
    applied: false,
  });

  try {
    if (pr.state !== "open") return skipped("the pull request is not open");
    if (!pr.author) return skipped("the author's account no longer exists");
    if (isBotAccount(pr.author, pr.authorType)) return skipped("the author is a bot");
    if (await hasWriteAccess(gh, pr)) return skipped("the author has write access to the repository");

    ({ config, source: configSource } = await loadConfig(gh, input));
    if (configSource.startsWith("built-in")) {
      warnings.push(`No rules found at ${input.configPath} on the default branch; using the built-in defaults.`);
    }

    const changedPaths = config.exemptPaths.length > 0 ? await changedFiles(gh, pr) : null;
    const sources = liveSources(gh, {
      repo: pr.repo,
      ownListPath: config.ownList?.path ?? null,
      ownListText: input.ownListText,
    });
    const decision = await evaluate(
      { config, repo: pr.repo, login: pr.author, at: input.now ?? new Date(), changedPaths },
      sources,
    );
    warnings.push(...sources.warnings);
    log(`${pr.repo}#${pr.number} by ${pr.author}: ${decision.status} (${decision.reason})`);

    const needsMessage = decision.status === "unknown" || decision.status === "denounced";
    const template = needsMessage ? await loadMessage(gh, pr.repo, config, warnings) : DEFAULT_MESSAGE;
    const actions = planActions({ decision, config, pr, trigger: input.trigger, template });
    if (!dryRun) await applyActions(gh, pr, actions);

    return {
      status: decision.status,
      reason: decision.reason,
      rule: decision.status === "admitted" ? decision.rule : null,
      actions,
      warnings,
      configSource,
      applied: !dryRun,
    };
  } catch (error) {
    const reason = `the check failed: ${(error as Error).message}`;
    log(reason);
    // Never close on an error. Label the PR so a maintainer looks at it, if we can.
    const labels = config?.labels ?? DEFAULT_LABELS;
    const actions: PlannedAction[] = labels.error ? [addLabel(labels.error, "error")] : [];
    if (!dryRun && actions.length > 0) {
      try {
        await applyActions(gh, pr, actions);
      } catch (labelError) {
        warnings.push(`Could not add the "${labels.error}" label either: ${(labelError as Error).message}`);
      }
    }
    return { status: "error", reason, rule: null, actions, warnings, configSource, applied: !dryRun };
  }
}

async function hasWriteAccess(gh: GitHubClient, pr: PullRequestInfo): Promise<boolean> {
  const { status, data } = await gh.rest<{ permission?: string }>(
    "GET",
    `/repos/${pr.repo}/collaborators/${encodeURIComponent(pr.author!)}/permission`,
    undefined,
    [403, 404],
  );
  if (status === 200) return WRITE_PERMISSIONS.has(data?.permission ?? "");
  // Without permission to ask, fall back to what GitHub says about the PR author.
  return MAINTAINER_ASSOCIATIONS.has(pr.association);
}

async function loadConfig(gh: GitHubClient, input: CheckInput): Promise<{ config: TrustConfig; source: string }> {
  if (input.configText != null) return { config: parseConfig(input.configText), source: "provided file" };
  return loadRules(gh, input.pr.repo, input.configPath);
}

/** The rules from the default branch, or the built-in defaults. Throws on a broken file. */
export async function loadRules(
  gh: GitHubClient,
  repo: string,
  configPath: string,
): Promise<{ config: TrustConfig; source: string }> {
  const found = await readFirstFile(gh, repo, [configPath]);
  if (!found) return { config: parseConfig(DEFAULT_CONFIG_YAML), source: "built-in defaults" };
  return { config: parseConfig(found.text), source: `${configPath} on the default branch` };
}

async function changedFiles(gh: GitHubClient, pr: PullRequestInfo): Promise<string[] | null> {
  const files: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const { data } = await gh.rest<{ filename: string }[]>(
      "GET",
      `/repos/${pr.repo}/pulls/${pr.number}/files?per_page=100&page=${page}`,
    );
    files.push(...data.map((f) => f.filename));
    if (data.length < 100) break;
  }
  // GitHub lists at most 3000 files; an incomplete list never counts as exempt.
  return files.length >= pr.changedFiles ? files : null;
}

const SITE = "https://maxbenschop.github.io/pr-trust";
const HEADING = (title: string) =>
  `### <img src="${SITE}/logo-mark.png" alt="" width="25" height="14">&nbsp; Contributor check: ${title}`;
const FOOTER = `<sub>Checked by <a href="${SITE}/">pr-trust</a>. It looks at who opened the pull request, never at the code.</sub>`;

export const DEFAULT_MESSAGE = `${HEADING("author not recognised yet")}

Thanks for opening this pull request, @{author}. This project accepts pull requests from contributors it already trusts, and this check could not confirm that for your account.

> [!{alert}]
> {next}

**You pass this check when you:**

{rules}

[What this label means, and how to get vouched](${SITE}/contributors/)

${FOOTER}`;

const DENOUNCED_MESSAGE = `${HEADING("not accepted")}

@{author}, this project does not accept pull requests from your account ({reason}).

> [!{alert}]
> {next}

${FOOTER}`;

function admittedMessage(author: string, reason: string): string {
  return `${COMMENT_MARKER}\n${HEADING("passed")}\n\nThanks, @${author}. This pull request now passes the contributor check.\n\n**Why:** ${reason}\n\n${FOOTER}\n`;
}

/** The project's rules as a list a contributor can read. */
export function describeWaysToPass(config: TrustConfig): string {
  const ways: string[] = [];
  if (config.ownList) ways.push("are vouched for by a maintainer of this project");
  for (const rule of config.admit) {
    if (rule.kind === "list") {
      ways.push(`are vouched for in [${rule.source.repo}](https://github.com/${rule.source.repo})`);
    } else {
      const where = rule.repo === SELF ? "this repository" : `[${rule.repo}](https://github.com/${rule.repo})`;
      const count = rule.min === 1 ? "a merged pull request" : `${rule.min} merged pull requests`;
      const period = rule.within.amount === 1 ? formatDuration(rule.within).slice(2) : formatDuration(rule.within);
      ways.push(`have ${count} in ${where} in the last ${period}`);
    }
  }
  if (ways.length === 0) return "- are admitted by a maintainer";
  return ways.map((way, i) => `- ${way}${i < ways.length - 1 ? ", or" : ""}`).join("\n");
}

async function loadMessage(gh: GitHubClient, repo: string, config: TrustConfig, warnings: string[]): Promise<string> {
  if (!config.messageFile) return DEFAULT_MESSAGE;
  const found = await readFirstFile(gh, repo, [config.messageFile]);
  if (found) return found.text;
  warnings.push(`message_file ${config.messageFile} was not found on the default branch; using the default message.`);
  return DEFAULT_MESSAGE;
}

export function renderMessage(
  template: string,
  values: { author: string; reason: string; repo: string; closing: boolean; denounced?: boolean; rules?: string },
): string {
  const denounced = values.denounced ?? false;
  const next = denounced
    ? `${values.closing ? "It has been closed automatically." : "A maintainer will decide what happens to it."} If you think this is a mistake, contact a maintainer.`
    : values.closing
      ? "It has been closed automatically. If you would like to contribute, introduce yourself in an issue or discussion so a maintainer can vouch for you, then open it again."
      : "A maintainer will review it when they can, which may take longer than usual.";
  const body = (denounced && template === DEFAULT_MESSAGE ? DENOUNCED_MESSAGE : template)
    .replaceAll("{author}", values.author)
    .replaceAll("{reason}", values.reason)
    .replaceAll("{repo}", values.repo)
    .replaceAll("{rules}", values.rules ?? "")
    .replaceAll("{alert}", values.closing ? "IMPORTANT" : "NOTE")
    .replaceAll("{next}", next);
  return `${COMMENT_MARKER}\n${body.trim()}\n`;
}

const LABEL_STYLE: Record<keyof Labels, { color: string; description: string }> = {
  admitted: { color: "0e8a16", description: "Author is trusted by this project's contributor rules" },
  unknown: { color: "fbca04", description: "No contributor rule admits this author yet" },
  denounced: { color: "b60205", description: "Author is denounced in this project's trust list" },
  error: { color: "ededed", description: "The contributor trust check failed; needs a maintainer" },
};

function addLabel(label: string, kind: keyof Labels): PlannedAction {
  return { kind: "add-label", label, ...LABEL_STYLE[kind] };
}

export function planActions(input: {
  decision: Decision;
  config: TrustConfig;
  pr: PullRequestInfo;
  trigger: Trigger;
  template: string;
}): PlannedAction[] {
  const { decision, config, pr, trigger } = input;
  const kind: keyof Labels =
    decision.status === "denounced" ? "denounced" : decision.status === "unknown" ? "unknown" : "admitted";
  const label = config.labels[kind];
  const actions: PlannedAction[] = [];

  // Swap any earlier result label for the current one.
  const ours = new Set(Object.values(config.labels).filter((l) => l !== ""));
  for (const existing of pr.labels) {
    if (ours.has(existing) && existing !== label) actions.push({ kind: "remove-label", label: existing });
  }
  if (label && !pr.labels.includes(label)) actions.push(addLabel(label, kind));

  if (kind === "admitted") {
    actions.push({
      kind: "update-comment",
      body: admittedMessage(pr.author!, decision.reason),
    });
    return actions;
  }

  // A maintainer reopening a closed PR overrides the gate; only label it.
  const reopenedByOther =
    trigger.action === "reopened" && !!trigger.sender && trigger.sender.toLowerCase() !== pr.author!.toLowerCase();
  const wantsClose = (kind === "unknown" ? config.onUnknown : config.onDenounced) === "close";
  const close = wantsClose && !reopenedByOther;

  if (close || config.comment === "unknown") {
    actions.push({
      kind: "comment",
      body: renderMessage(input.template, {
        author: pr.author!,
        reason: decision.reason,
        repo: pr.repo,
        closing: close,
        denounced: kind === "denounced",
        rules: describeWaysToPass(config),
      }),
    });
  }
  if (close) actions.push({ kind: "close" });
  return actions;
}

export async function applyActions(gh: GitHubClient, pr: PullRequestInfo, actions: PlannedAction[]): Promise<void> {
  const issue = `/repos/${pr.repo}/issues/${pr.number}`;
  for (const action of actions) {
    switch (action.kind) {
      case "add-label": {
        const name = encodeURIComponent(action.label);
        const existing = await gh.rest("GET", `/repos/${pr.repo}/labels/${name}`, undefined, [404]);
        if (existing.status === 404) {
          await gh.rest(
            "POST",
            `/repos/${pr.repo}/labels`,
            { name: action.label, color: action.color, description: action.description },
            [422], // created meanwhile by another run
          );
        }
        await gh.rest("POST", `${issue}/labels`, { labels: [action.label] });
        break;
      }
      case "remove-label":
        await gh.rest("DELETE", `${issue}/labels/${encodeURIComponent(action.label)}`, undefined, [404]);
        break;
      case "comment":
      case "update-comment": {
        const id = await findOurComment(gh, issue);
        if (id !== null) await gh.rest("PATCH", `/repos/${pr.repo}/issues/comments/${id}`, { body: action.body });
        else if (action.kind === "comment") await gh.rest("POST", `${issue}/comments`, { body: action.body });
        break;
      }
      case "close":
        await gh.rest("PATCH", `/repos/${pr.repo}/pulls/${pr.number}`, { state: "closed" });
        break;
    }
  }
}

async function findOurComment(gh: GitHubClient, issue: string): Promise<number | null> {
  for (let page = 1; page <= 10; page++) {
    const { data } = await gh.rest<{ id: number; body?: string; user?: { type?: string } }[]>(
      "GET",
      `${issue}/comments?per_page=100&page=${page}`,
    );
    // Only a bot's comment can be ours; a person could paste the marker into their own.
    const found = data.find((c) => c.user?.type === "Bot" && c.body?.startsWith(COMMENT_MARKER));
    if (found) return found.id;
    if (data.length < 100) return null;
  }
  return null;
}
