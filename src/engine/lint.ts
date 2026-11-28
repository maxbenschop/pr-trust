import picomatch from "picomatch";
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import {
  ConfigError,
  describeRule,
  listKey,
  parseConfig,
  SELF,
  type ConfigPath,
  type Labels,
  type MergedRule,
  type TrustConfig,
} from "./config.ts";
import { subtractDuration } from "./duration.ts";

/**
 * Checks a rules file without any network: everything the Action's parser rejects (errors),
 * plus settings that are valid but are probably not what the maintainer meant (warnings).
 */

export type Finding = {
  level: "error" | "warning";
  message: string;
  /** Where in the file, as keys and list indexes from the top; empty for the whole file. */
  path: ConfigPath;
  /** 1-based line in the file, when it can be found. */
  line: number | null;
};

export type Problem = { level: Finding["level"]; message: string; path: ConfigPath };

export type LintResult = { config: TrustConfig | null; findings: Finding[] };

export function lintConfig(text: string): LintResult {
  const locate = createLocator(text);
  let config: TrustConfig;
  try {
    config = parseConfig(text);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const findings = error.details.map((p): Finding => ({
      level: "error",
      message: p.message,
      path: p.path,
      line: p.line ?? locate(p.path),
    }));
    return { config: null, findings };
  }
  return { config, findings: configWarnings(config).map((w) => ({ ...w, line: locate(w.path) })) };
}

/** Days shorter than this in a `merged` window are probably a slip (24d for 24mo). */
const SHORT_WINDOW_DAYS = 28;

/** Paths of the kinds any project has; a pattern matching all of them exempts nearly everything. */
const PROBE_PATHS = ["src/main.rs", "lib/core/index.ts", "package.json", ".github/workflows/ci.yml"];

/** Valid settings that are probably mistakes. Few on purpose: each one should be worth acting on. */
export function configWarnings(config: TrustConfig): Problem[] {
  const warnings: Problem[] = [];
  const warn = (path: ConfigPath, message: string) => warnings.push({ level: "warning", message, path });

  if (config.onUnknown === "close" && config.ownList === null && config.admit.length === 0) {
    warn(
      ["on_unknown"],
      "on_unknown is close, but with own_list: none and no admit rules nobody can be admitted, so every " +
        "pull request from an outside contributor is closed (except ones that change only exempt paths)",
    );
  }

  config.admit.forEach((rule, j) => {
    for (let i = 0; i < config.admit.length; i++) {
      if (i === j) continue;
      const other = config.admit[i]!;
      if (rule.kind === "list" && other.kind === "list") {
        if (i < j && listKey(rule.source) === listKey(other.source)) {
          warn(["admit", j], `admit[${j}] repeats admit[${i}] (${describeRule(rule)}); remove one of them`);
          return;
        }
      } else if (rule.kind === "merged" && other.kind === "merged" && sameRepo(rule, other)) {
        const same = rule.min === other.min && windowDays(rule) === windowDays(other);
        if (same && i < j) {
          warn(["admit", j], `admit[${j}] repeats admit[${i}] (${describeRule(rule)}); remove one of them`);
          return;
        }
        if (!same && other.min <= rule.min && windowDays(other) >= windowDays(rule)) {
          warn(
            ["admit", j],
            `admit[${j}] (${describeRule(rule)}) never admits anyone: admit[${i}] (${describeRule(other)}) ` +
              `already admits everyone it would. Remove it, or make admit[${i}] stricter`,
          );
          return;
        }
      }
    }
  });

  config.admit.forEach((rule, i) => {
    if (rule.kind !== "merged") return;
    const days = windowDays(rule);
    if (days < SHORT_WINDOW_DAYS) {
      warn(
        ["admit", i, "merged", "within"],
        `admit[${i}].merged.within is only ${days} day${days === 1 ? "" : "s"}: only authors with a pull request ` +
          `merged that recently pass. For months, write mo, as in 24mo`,
      );
    }
  });

  config.exemptPaths.forEach((pattern, i) => {
    if (/^\.?\//.test(pattern)) {
      warn(
        ["exempt_paths", i],
        `exempt_paths pattern "${pattern}" never matches: changed files are named from the repository root, ` +
          `without a leading "/" or "./" (write "${pattern.replace(/^\.?\/+/, "")}")`,
      );
      return;
    }
    const matches = picomatch(pattern, { dot: true });
    if (PROBE_PATHS.every((p) => matches(p))) {
      warn(
        ["exempt_paths", i],
        `exempt_paths pattern "${pattern}" matches nearly every file (such as src/main.rs and package.json), ` +
          `so almost every pull request skips the check`,
      );
    }
  });

  for (const [key, path] of [
    ["own_list", config.ownList?.path ?? null],
    ["message_file", config.messageFile],
  ] as const) {
    if (path !== null && !isPlainPath(path)) {
      warn(
        [key],
        `${key} "${path}" is never found: write the path from the repository root, without a leading "/" or "./" ` +
          `and without "..", as in .github/${key === "own_list" ? "VOUCHED.td" : "trust-message.md"}`,
      );
    }
  }

  const seen = new Map<string, keyof Labels>();
  for (const [key, label] of Object.entries(config.labels) as [keyof Labels, string][]) {
    if (label === "") continue;
    const first = seen.get(label.toLowerCase());
    if (first) {
      warn(
        ["labels", key],
        `labels.${key} and labels.${first} are both "${label}" (GitHub ignores case in label names), ` +
          `so that label cannot tell the two results apart`,
      );
    } else seen.set(label.toLowerCase(), key);
  }

  return warnings;
}

function sameRepo(a: MergedRule, b: MergedRule): boolean {
  return a.repo.toLowerCase() === b.repo.toLowerCase();
}

/** A window's length in days, counted back from a fixed date so months and years compare. */
function windowDays(rule: MergedRule): number {
  const at = new Date(Date.UTC(2026, 0, 1));
  return Math.round((at.getTime() - subtractDuration(at, rule.within).getTime()) / 86_400_000);
}

function isPlainPath(path: string): boolean {
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Finds the line of a path in the file: the line of its key, or of the nearest enclosing
 * one when the path goes deeper than what is written.
 */
export function createLocator(text: string): (path: ConfigPath) => number | null {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  const lineOf = (node: unknown): number | null =>
    isNode(node) && node.range ? counter.linePos(node.range[0]).line : null;
  return (path) => {
    if (doc.errors.length > 0) return null;
    let node: unknown = doc.contents;
    let line: number | null = null;
    for (const key of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === key);
        if (!pair) break;
        line = lineOf(pair.key) ?? line;
        node = pair.value;
      } else if (isSeq(node) && typeof key === "number") {
        const item = node.items[key];
        if (item === undefined) break;
        line = lineOf(item) ?? line;
        node = item;
      } else break;
    }
    return line;
  };
}

export function formatPath(path: ConfigPath): string {
  return path.map((key, i) => (typeof key === "number" ? `[${key}]` : i === 0 ? key : `.${key}`)).join("");
}

export function formatFinding(file: string, finding: Finding): string {
  return `${file}${finding.line ? `:${finding.line}` : ""}: ${finding.level}: ${finding.message}`;
}

export function countFindings(findings: Finding[]): { errors: number; warnings: number } {
  const errors = findings.filter((f) => f.level === "error").length;
  return { errors, warnings: findings.length - errors };
}

/** One line, such as "trust.yml: 2 errors, 1 warning" or "trust.yml: no problems found". */
export function summaryLine(file: string, findings: Finding[], checked: string): string {
  const { errors, warnings } = countFindings(findings);
  if (errors + warnings === 0) return `${file}: no problems found (${checked})`;
  const parts = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  return `${file}: ${parts.join(", ")} (${checked})`;
}
