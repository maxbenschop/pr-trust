import picomatch from "picomatch";
import { ANY, describeRule, SELF, type ListRef, type Rule, type TrustConfig } from "./config.ts";
import { formatDuration, subtractDuration } from "./duration.ts";
import { normalizeLogin } from "./vouchfile.ts";

export type ListStatus = "vouched" | "denounced" | "unknown";
type MaybePromise<T> = T | Promise<T>;

/**
 * Where the facts come from. The Action answers these from live data at "now";
 * the backtest answers them from history at the moment each PR was opened.
 */
export interface TrustSources {
  ownList(login: string, at: Date): MaybePromise<ListStatus>;
  listVouches(source: ListRef, login: string, at: Date): MaybePromise<boolean>;
  /**
   * Merged PRs authored by `login` in `repo`, merged in [from, to). Only whether the count
   * reaches `min` matters, so a source may stop counting there and return `min`.
   */
  mergedCount(repo: string, login: string, from: Date, to: Date, min: number): MaybePromise<number>;
  /**
   * PRs authored by `login` merged in [from, to) into public repositories that `login` does
   * not own, leaving out PRs the author merged themselves. Stops counting at `min` as above.
   */
  mergedElsewhereCount(login: string, from: Date, to: Date, min: number): MaybePromise<number>;
  /** Whether `login` is a public member of the organisation `org` at `at`. */
  isPublicOrgMember(org: string, login: string, at: Date): MaybePromise<boolean>;
  /** When the account was created, or null when that cannot be told (no such user, a failed lookup). */
  accountCreatedAt(login: string): MaybePromise<Date | null>;
}

/**
 * The account was too new for `min_account_age`: `rule` would have admitted it otherwise.
 * Set on "unknown" decisions only, so a backtest can count what the floor holds back.
 */
export type HeldBack = { rule: string; accountCreatedAt: string | null };

export type Decision =
  | { status: "admitted"; rule: string; reason: string }
  | { status: "exempt"; reason: string }
  | { status: "denounced"; reason: string }
  | { status: "unknown"; reason: string; heldBack?: HeldBack };

export type EvaluateInput = {
  config: TrustConfig;
  /** The repository the PR was opened against, as owner/repo. Resolves `repo: self`. */
  repo: string;
  /** The account that opened the PR (never the commit author, which can be spoofed). */
  login: string;
  at: Date;
  /** Paths changed by the PR, or null when unknown or incomplete. */
  changedPaths: string[] | null;
};

export const OWN_LIST = "own list";

/** Checks rules in order and stops at the first match, so later lookups are skipped. */
export async function evaluate(input: EvaluateInput, sources: TrustSources): Promise<Decision> {
  const { config, at } = input;
  const login = normalizeLogin(input.login);

  const own = config.ownList ? await sources.ownList(login, at) : "unknown";
  if (own === "denounced") return { status: "denounced", reason: "denounced in this project's own list" };
  if (own === "vouched") return { status: "admitted", rule: OWN_LIST, reason: "vouched in this project's own list" };

  let heldBack: HeldBack | null = null;
  for (const rule of config.admit) {
    const reason = await matchRule(rule, input, login, sources);
    if (reason === null) continue;
    // The floor is checked only once a rule matches, so it costs nothing for everyone else.
    if (config.minAccountAge) {
      const created = await sources.accountCreatedAt(login);
      if (created === null || created > subtractDuration(at, config.minAccountAge)) {
        heldBack = { rule: describeRule(rule), accountCreatedAt: created?.toISOString() ?? null };
        break;
      }
    }
    return { status: "admitted", rule: describeRule(rule), reason };
  }

  if (config.exemptPaths.length > 0 && input.changedPaths && input.changedPaths.length > 0) {
    const matches = picomatch(config.exemptPaths, { dot: true });
    if (input.changedPaths.every((path) => matches(path))) {
      return { status: "exempt", reason: "only changes exempt paths" };
    }
  }

  if (heldBack && config.minAccountAge) {
    const age = formatDuration(config.minAccountAge);
    const reason =
      heldBack.accountCreatedAt === null
        ? `the account's age could not be confirmed, and rules other than this project's own list need an account at least ${age} old`
        : `the account is ${ageInDays(new Date(heldBack.accountCreatedAt), at)} old, and rules other than this project's own list need an account at least ${age} old`;
    return { status: "unknown", reason, heldBack };
  }
  return { status: "unknown", reason: "no rule admits this author" };
}

/** Why `rule` admits the author, or null when it does not. */
async function matchRule(rule: Rule, input: EvaluateInput, login: string, sources: TrustSources): Promise<string | null> {
  const { at } = input;
  if (rule.kind === "list") {
    return (await sources.listVouches(rule.source, login, at)) ? `vouched in ${rule.source.repo}` : null;
  }
  if (rule.kind === "org_member") {
    return (await sources.isPublicOrgMember(rule.org, login, at)) ? `public member of ${rule.org}` : null;
  }
  const from = subtractDuration(at, rule.within);
  if (rule.repo === ANY) {
    const count = await sources.mergedElsewhereCount(login, from, at, rule.min);
    return count >= rule.min ? `${count} merged PR${count === 1 ? "" : "s"} in others' public repositories` : null;
  }
  const repo = rule.repo === SELF ? input.repo : rule.repo;
  const count = await sources.mergedCount(repo, login, from, at, rule.min);
  return count >= rule.min ? `${count} merged PR${count === 1 ? "" : "s"} in ${repo}` : null;
}

function ageInDays(created: Date, at: Date): string {
  const days = Math.max(0, Math.floor((at.getTime() - created.getTime()) / 86_400_000));
  return `${days} day${days === 1 ? "" : "s"}`;
}

