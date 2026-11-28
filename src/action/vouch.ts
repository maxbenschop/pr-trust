/**
 * The `/vouch` comment command: a maintainer adds an account to the project's own Vouch
 * list from a pull request or issue, and the pull request is checked again.
 *
 * The comment body is untrusted input. Only its first line is looked at, and nothing from
 * it except a login that passed `isLogin` ever reaches a file, an API path or a reply.
 */
import { VOUCH_FILE_CANDIDATES } from "../engine/config.ts";
import { addVouch, isLogin } from "../engine/vouchfile.ts";
import type { GitHubClient } from "../github/client.ts";
import { GitHubError } from "../github/client.ts";
import { isBotAccount, loadRules, pullRequestFromApi, runCheck, WRITE_PERMISSIONS, type CheckResult } from "./check.ts";

/** A `/vouch` command: for a named account, or (`null`) for the pull request's author. */
export type VouchCommand = { kind: "vouch"; target: string | null } | { kind: "invalid" };

/** Where a new list goes when the project has none yet, as Vouch does. */
export const NEW_LIST_PATH = ".github/VOUCHED.td";

/**
 * Reads the command from the first line of a comment: `/vouch`, `/vouch @login` or
 * `/vouch login`. Returns null for anything else, and `invalid` for `/vouch` followed by
 * something that is not a single GitHub username.
 */
export function parseVouchCommand(body: unknown): VouchCommand | null {
  if (typeof body !== "string") return null;
  const first = (body.split("\n", 1)[0] ?? "").trim();
  if (first !== "/vouch" && !/^\/vouch[ \t]/.test(first)) return null;
  const arg = first.slice("/vouch".length).trim();
  if (arg === "") return { kind: "vouch", target: null };
  const login = arg.startsWith("@") ? arg.slice(1) : arg;
  return isLogin(login) ? { kind: "vouch", target: login } : { kind: "invalid" };
}

type Account = { login?: string; type?: string } | null | undefined;

/** The parts of an `issue_comment` event payload this reads. */
export type CommentEvent = {
  action?: string;
  comment?: { id?: number; body?: string; user?: Account };
  issue?: { number?: number; user?: Account; pull_request?: unknown };
  sender?: Account;
};

/**
 * - `ignored`: not a command, or not from someone allowed to use it; nothing was done.
 * - `vouched`: the account was added to the list.
 * - `already-vouched`: it was in the list already.
 * - `refused`: a command from a maintainer that cannot be carried out; they were told why.
 * - `failed`: the list could not be read or written; they were told what to do instead.
 */
export type CommandOutcome = "ignored" | "vouched" | "already-vouched" | "refused" | "failed";

export type CommandResult = {
  outcome: CommandOutcome;
  reason: string;
  /** The pull request check run after vouching for its author, if any. */
  check: CheckResult | null;
  warnings: string[];
};

export type CommandInput = {
  repo: string;
  event: CommentEvent;
  configPath: string;
  dryRun: boolean;
  log?: (message: string) => void;
};

export async function handleComment(gh: GitHubClient, input: CommandInput): Promise<CommandResult> {
  const { repo, event, dryRun } = input;
  const log = input.log ?? (() => {});
  const warnings: string[] = [];
  const done = (outcome: CommandOutcome, reason: string, check: CheckResult | null = null): CommandResult => {
    log(`/vouch: ${outcome} (${reason})`);
    return { outcome, reason, check, warnings };
  };

  // Cheap checks first: this runs on every comment in the repository.
  if (event.action !== "created") return done("ignored", "only new comments are read, not edited or deleted ones");
  const command = parseVouchCommand(event.comment?.body);
  if (!command) return done("ignored", "not a /vouch command");

  const commenter = event.comment?.user?.login ?? "";
  const commentId = event.comment?.id;
  const number = event.issue?.number;
  if (!isLogin(commenter) || event.comment?.user?.type === "Bot") return done("ignored", "bots cannot use /vouch");
  if (event.sender?.login?.toLowerCase() !== commenter.toLowerCase()) {
    return done("ignored", "the event's sender is not the comment's author");
  }
  if (typeof commentId !== "number" || typeof number !== "number") return done("ignored", "the event has no comment or issue");

  // Ask GitHub, never author_association: only a direct permission check is authoritative.
  const permission = await gh.rest<{ permission?: string }>(
    "GET",
    `/repos/${repo}/collaborators/${encodeURIComponent(commenter)}/permission`,
    undefined,
    [403, 404],
  );
  if (permission.status !== 200 || !WRITE_PERMISSIONS.has(permission.data?.permission ?? "")) {
    // No reply: anyone can post "/vouch", and answering would let them make the bot comment.
    return done("ignored", `@${commenter} does not have write access to ${repo}`);
  }

  // From here the commenter is a maintainer, so problems are worth a short reply.
  const reply = async (text: string) => {
    if (dryRun) return log(`Would reply: ${text}`);
    try {
      await gh.rest("POST", `/repos/${repo}/issues/${number}/comments`, { body: `@${commenter} ${text}` });
    } catch (error) {
      warnings.push(`Could not reply on #${number}: ${(error as Error).message}`);
    }
  };
  const refuse = async (reason: string, text: string) => {
    await reply(text);
    return done("refused", reason);
  };

  try {
    return await carryOut(command);
  } catch (error) {
    // Never anything that changes the pull request; tell the maintainer instead.
    const why = (error as Error).message;
    await reply(`Something went wrong, and \`/vouch\` may not have finished: ${why}`);
    return done("failed", `the command failed: ${why}`);
  }

  async function carryOut(command: VouchCommand): Promise<CommandResult> {
    const isPullRequest = event.issue?.pull_request != null;
    if (command.kind === "invalid") {
      return refuse("the command does not name one GitHub username", "`/vouch` takes one GitHub username, like `/vouch @octocat`. Nothing was changed.");
    }
    if (command.target === null && !isPullRequest) {
      return refuse("bare /vouch on an issue", "On an issue, name the account to vouch for, like `/vouch @octocat`. Nothing was changed.");
    }

    const issueAuthor = event.issue?.user;
    if (command.target === null && isBotAccount(issueAuthor?.login ?? "", issueAuthor?.type ?? null)) {
      return refuse("the author is a bot", "Bots do not need vouching: the contributor check skips them. Nothing was changed.");
    }
    const named = command.target ?? issueAuthor?.login ?? "";
    if (!isLogin(named)) return refuse("no author to vouch for", "This pull request's author account no longer exists. Nothing was changed.");

    const user = await gh.rest<{ login?: string; type?: string }>("GET", `/users/${encodeURIComponent(named)}`, undefined, [404]);
    if (user.status === 404 || !user.data?.login) {
      return refuse(`no account named ${named}`, `There is no GitHub account named \`${named}\`. Nothing was changed.`);
    }
    if (user.data.type !== "User") {
      return refuse(`${named} is not a user account`, `\`${user.data.login}\` is not a personal account (it is a ${String(user.data.type).toLowerCase()}), so it cannot be vouched for. Nothing was changed.`);
    }
    const login = user.data.login;
    if (!isLogin(login)) return refuse(`unexpected login ${JSON.stringify(login)}`, "GitHub returned an unexpected username. Nothing was changed.");

    let rules;
    try {
      rules = await loadRules(gh, repo, input.configPath);
    } catch (error) {
      await reply(`Could not read this project's rules (${input.configPath}), so nothing was changed: ${(error as Error).message}`);
      return done("failed", `could not read the rules: ${(error as Error).message}`);
    }
    if (!rules.config.ownList) {
      return refuse(
        "own_list is none",
        `This project's rules set \`own_list: none\`, so there is no trust list to add \`${login}\` to. Nothing was changed. ` +
          `To vouch from comments, set \`own_list\` to \`auto\` or a file path in \`${input.configPath}\`.`,
      );
    }
    const configured = rules.config.ownList.path;
    if (configured !== null && !isSafePath(configured)) {
      return refuse(`own_list path ${JSON.stringify(configured)} is not a plain file path`, `\`own_list\` in \`${input.configPath}\` is not a plain file path in this repository, so nothing was changed.`);
    }

    // Read, edit and write the list; on a conflict (another commit landed meanwhile), read it
    // again and try once more.
    const message = `Vouch for @${login}\n\n@${commenter} vouched for @${login} with /vouch in #${number}.\n`;
    let written: { path: string; text: string } | null = null;
    let already: { path: string; text: string } | null = null;
    let lastError: GitHubError | Error | null = null;
    let path = configured ?? NEW_LIST_PATH;
    for (let attempt = 1; attempt <= 2 && !written && !already; attempt++) {
      let current: ListFile;
      try {
        current = await readList(gh, repo, configured);
      } catch (error) {
        lastError = error as Error;
        break;
      }
      path = current.path;
      const edit = addVouch(current.text, login);
      if (edit.result === "denounced") {
        return refuse(
          `${login} is denounced in ${path}`,
          `\`${login}\` is denounced in \`${path}\`, and \`/vouch\` does not overturn a denouncement. Nothing was changed. ` +
            `If you want to vouch for them, remove their \`-\` line from \`${path}\` on the default branch first.`,
        );
      }
      if (edit.result === "already-vouched") {
        already = { path, text: current.text! };
        break;
      }
      if (dryRun) {
        log(`Would add ${login} to ${path} (commit "${message.split("\n", 1)[0]}")`);
        written = { path, text: edit.text };
        break;
      }
      const put = await gh.rest<{ message?: string }>(
        "PUT",
        `/repos/${repo}/contents/${encodePath(path)}`,
        { message, content: Buffer.from(edit.text, "utf8").toString("base64"), ...(current.sha ? { sha: current.sha } : {}) },
        [403, 404, 409, 422],
      );
      if (put.status === 200 || put.status === 201) written = { path, text: edit.text };
      else {
        lastError = new GitHubError(`${put.status} ${put.data?.message ?? ""}`.trim(), put.status);
        // Only a conflict is worth a fresh read; a missing permission will not change.
        const conflict = put.status === 409 || put.status === 422;
        log(`Writing ${path} failed (${lastError.message})${conflict && attempt === 1 ? "; reading it again and retrying once" : ""}`);
        if (!conflict) break;
      }
    }

    if (!written && !already) {
      await reply(writeFailureText(login, path, lastError));
      return done("failed", `could not add ${login} to ${path}: ${lastError?.message ?? "unknown error"}`);
    }

    const result = (written ?? already)!;
    if (!dryRun) {
      try {
        await gh.rest("POST", `/repos/${repo}/issues/comments/${commentId}/reactions`, { content: "+1" });
      } catch (error) {
        warnings.push(`Could not react to the /vouch comment: ${(error as Error).message}`);
      }
    }
    const outcome: CommandOutcome = written ? "vouched" : "already-vouched";
    const reason = written
      ? `${dryRun ? "would add" : "added"} ${login} to ${result.path}, at @${commenter}'s request`
      : `${login} is already vouched for in ${result.path}`;

    // Check the pull request again so its label and comment catch up. The list is passed in
    // as written, since reading it back right away might not see the new commit yet.
    if (!isPullRequest || issueAuthor?.login?.toLowerCase() !== login.toLowerCase()) return done(outcome, reason);
    try {
      const { data } = await gh.rest<Record<string, unknown>>("GET", `/repos/${repo}/pulls/${number}`);
      const check = await runCheck(gh, {
        pr: pullRequestFromApi(repo, data),
        trigger: { action: "vouched", sender: commenter },
        configPath: input.configPath,
        dryRun,
        ownListText: result.text,
        log,
      });
      return done(outcome, `${reason}; check: ${check.status} (${check.reason})`, check);
    } catch (error) {
      warnings.push(`Vouched, but checking #${number} again failed: ${(error as Error).message}`);
      return done(outcome, reason);
    }
  }
}

type ListFile = { path: string; text: string | null; sha: string | null };

/**
 * The own list from the default branch through the Contents API, with the blob sha needed
 * to update it. With `own_list: auto`, the first existing usual location, else where a new
 * list goes.
 */
async function readList(gh: GitHubClient, repo: string, configured: string | null): Promise<ListFile> {
  for (const path of configured ? [configured] : VOUCH_FILE_CANDIDATES) {
    const { status, data } = await gh.rest<{ type?: string; sha?: string; content?: string; encoding?: string }>(
      "GET",
      `/repos/${repo}/contents/${encodePath(path)}`,
      undefined,
      [404],
    );
    if (status === 404) continue;
    if (data?.type !== "file" || typeof data.sha !== "string") throw new Error(`${path} is not a file`);
    if (data.encoding !== "base64" || typeof data.content !== "string") throw new Error(`${path} is too large to edit through the API`);
    return { path, text: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
  }
  return { path: configured ?? NEW_LIST_PATH, text: null, sha: null };
}

function isSafePath(path: string): boolean {
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..") && !/[\0\\]/.test(path);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function writeFailureText(login: string, path: string, error: Error | null): string {
  const status = error instanceof GitHubError ? error.status : null;
  const what = `Could not add \`${login}\` to \`${path}\`${error ? ` (GitHub said: ${error.message})` : ""}, so nothing was changed.`;
  const byHand = `add the line \`${login.toLowerCase()}\` to \`${path}\` on the default branch yourself, then comment \`/vouch\` again to re-run the check.`;
  if (status === 403 || status === 404) {
    return `${what} The workflow's token cannot write to the repository: give the workflow \`permissions: contents: write\`, or ${byHand}`;
  }
  if (status === 409 || status === 422) {
    return `${what} If the default branch is protected, let GitHub Actions push to it, or ${byHand}`;
  }
  return `${what} Try again, or ${byHand}`;
}
