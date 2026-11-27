import type { CheckResult, PlannedAction } from "./check.ts";

export function describeAction(action: PlannedAction): string {
  switch (action.kind) {
    case "add-label":
      return `add label "${action.label}"`;
    case "remove-label":
      return `remove label "${action.label}"`;
    case "comment":
      return "post or update a comment";
    case "update-comment":
      return "update the earlier comment, if any";
    case "close":
      return "close the pull request";
  }
}

export function summaryMarkdown(prRef: string, result: CheckResult): string {
  const lines = [
    `### Contributor trust check: ${result.status}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Pull request | ${prRef} |`,
    `| Reason | ${result.reason} |`,
    `| Rules | ${result.configSource} |`,
    `| Actions${result.applied ? "" : " (dry run, not applied)"} | ${result.actions.map(describeAction).join("; ") || "none"} |`,
  ];
  if (result.warnings.length > 0) lines.push("", ...result.warnings.map((w) => `- ${w}`));
  return `${lines.join("\n")}\n`;
}
