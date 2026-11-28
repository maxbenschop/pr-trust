import { parse as parseYaml } from "yaml";
import { formatDuration, parseDuration, type Duration } from "./duration.ts";

/** A trust list in some repository. `path: null` means "look in the usual Vouch locations". */
export type ListRef = { repo: string; path: string | null };

export type ListRule = { kind: "list"; source: ListRef };
/** `repo` is "self", "any" (public repositories the author does not own), or owner/repo. */
export type MergedRule = { kind: "merged"; repo: string; min: number; within: Duration };
/** The author is a public member of `org`. */
export type OrgMemberRule = { kind: "org_member"; org: string };
export type Rule = ListRule | MergedRule | OrgMemberRule;

export type TrustConfig = {
  /** The project's own list: the only list whose denouncements count. */
  ownList: { path: string | null } | null;
  admit: Rule[];
  /**
   * Accounts younger than this when the PR was opened are not admitted by `admit` rules.
   * The own list is unaffected. Null (the default) turns the floor off.
   */
  minAccountAge: Duration | null;
  exemptPaths: string[];
  onUnknown: "label" | "close";
  onDenounced: "label" | "close";
  /** "unknown": comment on PRs the rules don't admit. Closing always comes with a comment. */
  comment: "unknown" | "never";
  /** Path in this repo to a Markdown message for unadmitted authors; null uses the default. */
  messageFile: string | null;
  /** Label per result; an empty string turns that label off. */
  labels: Labels;
};

export type Labels = { admitted: string; unknown: string; denounced: string; error: string };

export const DEFAULT_LABELS: Labels = {
  admitted: "trust: admitted",
  unknown: "trust: unknown",
  denounced: "trust: denounced",
  error: "trust: check failed",
};

export const SELF = "self";
/** `merged.repo: any`: merges in public repositories the author does not own. */
export const ANY = "any";
export const DEFAULT_WITHIN: Duration = { amount: 24, unit: "mo" };
export const VOUCH_FILE_CANDIDATES = [".github/VOUCHED.td", "VOUCHED.td"];

export const DEFAULT_CONFIG_YAML = `own_list: auto
admit:
  - merged: { repo: self, min: 1, within: 24mo }
`;

/** Where a problem is in the rules file: keys and list indexes from the top, as in admit[0].merged. */
export type ConfigPath = (string | number)[];

/** One problem in a rules file. `line` is set when the YAML itself could not be read. */
export type ConfigProblem = { message: string; path: ConfigPath; line?: number };

export class ConfigError extends Error {
  readonly problems: string[];
  readonly details: ConfigProblem[];
  constructor(problems: (string | ConfigProblem)[]) {
    const details = problems.map((p) => (typeof p === "string" ? { message: p, path: [] } : p));
    super(`Invalid trust config:\n${details.map((p) => `  - ${p.message}`).join("\n")}`);
    this.problems = details.map((p) => p.message);
    this.details = details;
  }
}

class Problems {
  readonly list: ConfigProblem[] = [];
  add(path: ConfigPath, message: string): void {
    this.list.push({ message, path });
  }
  get length(): number {
    return this.list.length;
  }
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function isRepoName(value: string): boolean {
  return REPO.test(value);
}

export function parseConfig(text: string): TrustConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    throw new ConfigError([{ message: `not valid YAML: ${(error as Error).message}`, path: [], ...(line ? { line } : {}) }]);
  }
  return validateConfig(raw ?? {});
}

export const CONFIG_KEYS = [
  "version",
  "own_list",
  "admit",
  "min_account_age",
  "exempt_paths",
  "on_unknown",
  "on_denounced",
  "comment",
  "message_file",
  "labels",
] as const;

const MERGED_KEYS = ["repo", "min", "within"];
const RULE_KINDS = ["list", "merged", "org_member"];
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function validateConfig(raw: unknown): TrustConfig {
  const problems = new Problems();
  if (!isObject(raw)) throw new ConfigError(["the config must be a mapping of keys such as admit: and on_unknown:"]);

  for (const key of Object.keys(raw)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) problems.add([key], `unknown key "${key}"${didYouMean(key, CONFIG_KEYS)}`);
  }

  if (raw.version !== undefined && raw.version !== 1) problems.add(["version"], `version must be 1`);

  const ownList = parseOwnList(raw.own_list, problems);

  const admit: Rule[] = [];
  if (raw.admit !== undefined) {
    if (!Array.isArray(raw.admit)) {
      problems.add(["admit"], `admit must be a list; start each rule with "- ", as in "- list: owner/repo"`);
    } else raw.admit.forEach((entry, i) => {
      const rule = parseRule(entry, i, problems);
      if (rule) admit.push(rule);
    });
  }

  let minAccountAge: Duration | null = null;
  if (raw.min_account_age !== undefined && raw.min_account_age !== null && raw.min_account_age !== false) {
    const parsed = typeof raw.min_account_age === "string" ? parseDuration(raw.min_account_age) : null;
    if (parsed) minAccountAge = parsed;
    else problems.add(["min_account_age"], `min_account_age must look like 30d, 8w, 6mo or 1y${monthsHint(raw.min_account_age)}`);
  }

  const exemptPaths: string[] = [];
  if (raw.exempt_paths !== undefined) {
    if (!Array.isArray(raw.exempt_paths) || !raw.exempt_paths.every((p) => typeof p === "string" && p !== "")) {
      problems.add(
        ["exempt_paths"],
        typeof raw.exempt_paths === "string"
          ? `exempt_paths must be a list of glob patterns, such as ["${raw.exempt_paths}"]`
          : `exempt_paths must be a list of glob patterns`,
      );
    } else exemptPaths.push(...(raw.exempt_paths as string[]));
  }

  const onUnknown = parseChoice(raw, "on_unknown", ["label", "close"], "label", problems);
  const onDenounced = parseChoice(raw, "on_denounced", ["label", "close"], "close", problems);
  const comment = parseChoice(raw, "comment", ["unknown", "never"], "unknown", problems);

  let messageFile: string | null = null;
  if (raw.message_file !== undefined) {
    if (typeof raw.message_file === "string" && raw.message_file.trim() !== "") messageFile = raw.message_file.trim();
    else problems.add(["message_file"], `message_file must be a file path`);
  }

  const labels: Labels = { ...DEFAULT_LABELS };
  if (raw.labels !== undefined) {
    if (!isObject(raw.labels)) problems.add(["labels"], `labels must be a mapping`);
    else {
      for (const [key, value] of Object.entries(raw.labels)) {
        if (!(key in DEFAULT_LABELS)) {
          const hint = didYouMean(key, Object.keys(DEFAULT_LABELS)) || " (expected admitted, unknown, denounced, error)";
          problems.add(["labels", key], `labels: unknown key "${key}"${hint}`);
        } else if (typeof value !== "string" || value.length > 50) {
          problems.add(["labels", key], `labels.${key} must be text of at most 50 characters`);
        } else labels[key as keyof Labels] = value.trim();
      }
    }
  }

  if (problems.length > 0) throw new ConfigError(problems.list);
  return { ownList, admit, minAccountAge, exemptPaths, onUnknown, onDenounced, comment, messageFile, labels };
}

function parseChoice<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  choices: readonly T[],
  fallback: T,
  problems: Problems,
): T {
  const value = raw[key];
  if (value === undefined) return fallback;
  if ((choices as readonly unknown[]).includes(value)) return value as T;
  const hint = typeof value === "string" ? didYouMean(value, choices) : "";
  problems.add([key], `${key} must be ${choices.map((c) => `"${c}"`).join(" or ")}${hint}`);
  return fallback;
}

function parseOwnList(value: unknown, problems: Problems): TrustConfig["ownList"] {
  if (value === undefined || value === "auto") return { path: null };
  if (value === false || value === "none" || value === null) return null;
  if (typeof value === "string" && value.trim() !== "") return { path: value.trim() };
  problems.add(["own_list"], `own_list must be "auto", "none", or a file path`);
  return null;
}

function parseRule(entry: unknown, index: number, problems: Problems): Rule | null {
  const where = `admit[${index}]`;
  const path = ["admit", index];
  if (!isObject(entry)) {
    const asList = typeof entry === "string" ? parseListRef(entry) : null;
    problems.add(
      path,
      asList
        ? `${where} must be a rule; to trust ${asList.repo}'s Vouch list, write "- list: ${entry}"`
        : `${where} must be a mapping such as { list: owner/repo }, { merged: {...} } or { org_member: some-org }`,
    );
    return null;
  }
  const keys = Object.keys(entry);
  if (keys.length !== 1) {
    const misplaced = keys.filter((k) => MERGED_KEYS.includes(k));
    problems.add(
      path,
      "merged" in entry && misplaced.length > 0
        ? `${where} must have exactly one key ("list", "merged" or "org_member"); ${misplaced.join(" and ")} belong${misplaced.length === 1 ? "s" : ""} ` +
            `inside it: indent ${misplaced.length === 1 ? "it" : "them"} further than merged:, or write merged: { repo: self, min: 1, within: 24mo }`
        : `${where} must have exactly one key ("list", "merged" or "org_member")`,
    );
    return null;
  }

  if ("list" in entry) {
    const source = parseListRef(entry.list);
    if (!source) {
      const url = typeof entry.list === "string" ? /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(entry.list.trim()) : null;
      problems.add(
        [...path, "list"],
        `${where}.list must be "owner/repo" or "owner/repo:path/to/VOUCHED.td"${url ? ` (did you mean "${url[1]}"?)` : ""}`,
      );
      return null;
    }
    return { kind: "list", source };
  }

  if ("merged" in entry) {
    const m = entry.merged;
    if (!isObject(m)) {
      problems.add([...path, "merged"], `${where}.merged must be a mapping like { repo: owner/repo, min: 3, within: 24mo }`);
      return null;
    }
    const before = problems.length;
    for (const key of Object.keys(m)) {
      if (!MERGED_KEYS.includes(key)) problems.add([...path, "merged", key], `${where}.merged: unknown key "${key}"${didYouMean(key, MERGED_KEYS)}`);
    }
    const repo = typeof m.repo === "string" ? m.repo.trim() : "";
    if (repo !== SELF && repo !== ANY && !isRepoName(repo)) {
      problems.add([...path, "merged", "repo"], `${where}.merged.repo must be "self", "any" or "owner/repo"`);
    }
    const min = m.min ?? 1;
    if (typeof min !== "number" || !Number.isInteger(min) || min < 1) {
      problems.add([...path, "merged", "min"], `${where}.merged.min must be a whole number of at least 1`);
    }
    let within = DEFAULT_WITHIN;
    if (m.within !== undefined) {
      const parsed = typeof m.within === "string" ? parseDuration(m.within) : null;
      if (parsed) within = parsed;
      else problems.add([...path, "merged", "within"], `${where}.merged.within must look like 90d, 12w, 24mo or 2y${monthsHint(m.within)}`);
    }
    if (problems.length > before) return null;
    return { kind: "merged", repo, min: min as number, within };
  }

  if ("org_member" in entry) {
    const value = entry.org_member;
    const org = typeof value === "string" ? value.trim() : "";
    if (!ORG.test(org)) {
      const hint = typeof value === "string" ? /^(?:@|https?:\/\/github\.com\/)([A-Za-z0-9-]+)\/?$/.exec(value.trim()) : null;
      problems.add(
        [...path, "org_member"],
        `${where}.org_member must be an organisation's login, such as rust-lang${hint ? ` (did you mean "${hint[1]}"?)` : ""}`,
      );
      return null;
    }
    return { kind: "org_member", org };
  }

  const hint = didYouMean(keys[0]!, RULE_KINDS) || ` (expected "list", "merged" or "org_member")`;
  problems.add(path, `${where} has unknown rule "${keys[0]}"${hint}`);
  return null;
}

/** "24m" is the usual slip: months are "mo", since "m" could be read as minutes. */
function monthsHint(value: unknown): string {
  const months = typeof value === "string" ? /^\s*(\d+)\s*m(?:onths?)?\s*$/i.exec(value) : null;
  return months ? ` (did you mean "${months[1]}mo"?)` : "";
}

/**
 * " (did you mean "x"?)" when `value` is a near miss for one of `options`: another case,
 * hyphens or spaces for underscores, one or two letters off, or one written out longer or
 * shorter ("minimum" for "min", "exempt" for "exempt_paths"). Otherwise "".
 */
export function didYouMean(value: string, options: readonly string[]): string {
  const want = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const option of options) {
    const prefix = Math.min(want.length, option.length) >= 3 && (want.startsWith(option) || option.startsWith(want));
    const distance = prefix ? 1 : editDistance(want, option);
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  if (best === null || best === value) return "";
  return bestDistance <= Math.min(2, Math.floor(best.length / 3)) ? ` (did you mean "${best}"?)` : "";
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

export function parseListRef(value: unknown): ListRef | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const colon = text.indexOf(":");
  const repo = colon === -1 ? text : text.slice(0, colon);
  const path = colon === -1 ? null : text.slice(colon + 1).replace(/^\/+/, "");
  if (!isRepoName(repo) || path === "") return null;
  return { repo, path };
}

export function listKey(ref: ListRef): string {
  return `${ref.repo.toLowerCase()}:${ref.path ?? "auto"}`;
}

export function describeRule(rule: Rule): string {
  if (rule.kind === "list") {
    return `vouched in ${rule.source.repo}${rule.source.path ? `:${rule.source.path}` : ""}`;
  }
  if (rule.kind === "org_member") return `public member of ${rule.org}`;
  const where = rule.repo === SELF ? "this repo" : rule.repo === ANY ? "others' public repos" : rule.repo;
  return `≥${rule.min} merged PR${rule.min === 1 ? "" : "s"} in ${where} within ${formatDuration(rule.within)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
