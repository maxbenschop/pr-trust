import picomatch from "picomatch";
import { describeRule, SELF, type ListRef, type TrustConfig } from "./config.ts";
import { subtractDuration } from "./duration.ts";
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
}

export type Decision =
  | { status: "admitted"; rule: string; reason: string }
  | { status: "exempt"; reason: string }
  | { status: "denounced"; reason: string }
  | { status: "unknown"; reason: string };

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

  for (const rule of config.admit) {
    if (rule.kind === "list") {
      if (await sources.listVouches(rule.source, login, at)) {
        return { status: "admitted", rule: describeRule(rule), reason: `vouched in ${rule.source.repo}` };
      }
      continue;
    }
    const repo = rule.repo === SELF ? input.repo : rule.repo;
    const count = await sources.mergedCount(repo, login, subtractDuration(at, rule.within), at, rule.min);
    if (count >= rule.min) {
      return {
        status: "admitted",
        rule: describeRule(rule),
        reason: `${count} merged PR${count === 1 ? "" : "s"} in ${repo}`,
      };
    }
  }

  if (config.exemptPaths.length > 0 && input.changedPaths && input.changedPaths.length > 0) {
    const matches = picomatch(config.exemptPaths, { dot: true });
    if (input.changedPaths.every((path) => matches(path))) {
      return { status: "exempt", reason: "only changes exempt paths" };
    }
  }

  return { status: "unknown", reason: "no rule admits this author" };
}

