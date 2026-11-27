import { parse as parseYaml } from "yaml";
import { formatDuration, parseDuration, type Duration } from "./duration.ts";

/** A trust list in some repository. `path: null` means "look in the usual Vouch locations". */
export type ListRef = { repo: string; path: string | null };

export type ListRule = { kind: "list"; source: ListRef };
export type MergedRule = { kind: "merged"; repo: string; min: number; within: Duration };
export type Rule = ListRule | MergedRule;

export type TrustConfig = {
  /** The project's own list: the only list whose denouncements count. */
  ownList: { path: string | null } | null;
  admit: Rule[];
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
export const DEFAULT_WITHIN: Duration = { amount: 24, unit: "mo" };
export const VOUCH_FILE_CANDIDATES = [".github/VOUCHED.td", "VOUCHED.td"];

export const DEFAULT_CONFIG_YAML = `own_list: auto
admit:
  - merged: { repo: self, min: 1, within: 24mo }
`;

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid trust config:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
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
    throw new ConfigError([`not valid YAML: ${(error as Error).message}`]);
  }
  return validateConfig(raw ?? {});
}

export function validateConfig(raw: unknown): TrustConfig {
  const problems: string[] = [];
  if (!isObject(raw)) throw new ConfigError(["the config must be a mapping"]);

  const known = new Set([
    "version",
    "own_list",
    "admit",
    "exempt_paths",
    "on_unknown",
    "on_denounced",
    "comment",
    "message_file",
    "labels",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) problems.push(`unknown key "${key}"`);
  }

  if (raw.version !== undefined && raw.version !== 1) problems.push(`version must be 1`);

  const ownList = parseOwnList(raw.own_list, problems);

  const admit: Rule[] = [];
  if (raw.admit !== undefined) {
    if (!Array.isArray(raw.admit)) problems.push(`admit must be a list`);
    else raw.admit.forEach((entry, i) => {
      const rule = parseRule(entry, `admit[${i}]`, problems);
      if (rule) admit.push(rule);
    });
  }

  const exemptPaths: string[] = [];
  if (raw.exempt_paths !== undefined) {
    if (!Array.isArray(raw.exempt_paths) || !raw.exempt_paths.every((p) => typeof p === "string" && p !== "")) {
      problems.push(`exempt_paths must be a list of glob patterns`);
    } else exemptPaths.push(...(raw.exempt_paths as string[]));
  }

  let onUnknown: TrustConfig["onUnknown"] = "label";
  if (raw.on_unknown !== undefined) {
    if (raw.on_unknown === "label" || raw.on_unknown === "close") onUnknown = raw.on_unknown;
    else problems.push(`on_unknown must be "label" or "close"`);
  }

  let onDenounced: TrustConfig["onDenounced"] = "close";
  if (raw.on_denounced !== undefined) {
    if (raw.on_denounced === "label" || raw.on_denounced === "close") onDenounced = raw.on_denounced;
    else problems.push(`on_denounced must be "label" or "close"`);
  }

  let comment: TrustConfig["comment"] = "unknown";
  if (raw.comment !== undefined) {
    if (raw.comment === "unknown" || raw.comment === "never") comment = raw.comment;
    else problems.push(`comment must be "unknown" or "never"`);
  }

  let messageFile: string | null = null;
  if (raw.message_file !== undefined) {
    if (typeof raw.message_file === "string" && raw.message_file.trim() !== "") messageFile = raw.message_file.trim();
    else problems.push(`message_file must be a file path`);
  }

  const labels: Labels = { ...DEFAULT_LABELS };
  if (raw.labels !== undefined) {
    if (!isObject(raw.labels)) problems.push(`labels must be a mapping`);
    else {
      for (const [key, value] of Object.entries(raw.labels)) {
        if (!(key in DEFAULT_LABELS)) problems.push(`labels: unknown key "${key}" (expected admitted, unknown, denounced, error)`);
        else if (typeof value !== "string" || value.length > 50) problems.push(`labels.${key} must be text of at most 50 characters`);
        else labels[key as keyof Labels] = value.trim();
      }
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { ownList, admit, exemptPaths, onUnknown, onDenounced, comment, messageFile, labels };
}

function parseOwnList(value: unknown, problems: string[]): TrustConfig["ownList"] {
  if (value === undefined || value === "auto") return { path: null };
  if (value === false || value === "none" || value === null) return null;
  if (typeof value === "string" && value.trim() !== "") return { path: value.trim() };
  problems.push(`own_list must be "auto", "none", or a file path`);
  return null;
}

function parseRule(entry: unknown, where: string, problems: string[]): Rule | null {
  if (!isObject(entry)) {
    problems.push(`${where} must be a mapping such as { list: owner/repo } or { merged: {...} }`);
    return null;
  }
  const keys = Object.keys(entry);
  if (keys.length !== 1) {
    problems.push(`${where} must have exactly one key ("list" or "merged")`);
    return null;
  }

  if ("list" in entry) {
    const source = parseListRef(entry.list);
    if (!source) {
      problems.push(`${where}.list must be "owner/repo" or "owner/repo:path/to/VOUCHED.td"`);
      return null;
    }
    return { kind: "list", source };
  }

  if ("merged" in entry) {
    const m = entry.merged;
    if (!isObject(m)) {
      problems.push(`${where}.merged must be a mapping like { repo: owner/repo, min: 3, within: 24mo }`);
      return null;
    }
    const before = problems.length;
    for (const key of Object.keys(m)) {
      if (!["repo", "min", "within"].includes(key)) problems.push(`${where}.merged: unknown key "${key}"`);
    }
    const repo = typeof m.repo === "string" ? m.repo.trim() : "";
    if (repo !== SELF && !isRepoName(repo)) problems.push(`${where}.merged.repo must be "self" or "owner/repo"`);
    const min = m.min ?? 1;
    if (typeof min !== "number" || !Number.isInteger(min) || min < 1) {
      problems.push(`${where}.merged.min must be a whole number of at least 1`);
    }
    let within = DEFAULT_WITHIN;
    if (m.within !== undefined) {
      const parsed = typeof m.within === "string" ? parseDuration(m.within) : null;
      if (parsed) within = parsed;
      else problems.push(`${where}.merged.within must look like 90d, 12w, 24mo or 2y`);
    }
    if (problems.length > before) return null;
    return { kind: "merged", repo, min: min as number, within };
  }

  problems.push(`${where} has unknown rule "${keys[0]}" (expected "list" or "merged")`);
  return null;
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
  const where = rule.repo === SELF ? "this repo" : rule.repo;
  return `≥${rule.min} merged PR${rule.min === 1 ? "" : "s"} in ${where} within ${formatDuration(rule.within)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
