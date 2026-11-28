/**
 * GitHub Action entry point. Reads the event and inputs from the runner's environment,
 * runs the check and reports through outputs, annotations and the job summary.
 * Inputs: github-token, config, dry-run, pr-number, as-author, fail-on-error.
 * On an `issue_comment` event it handles the `/vouch` command instead (see vouch.ts).
 */
import fs from "node:fs";
import { createClient } from "../github/client.ts";
import { asAuthor, pullRequestFromApi, runCheck } from "./check.ts";
import { describeAction, summaryMarkdown } from "./report.ts";
import { handleComment } from "./vouch.ts";

function input(name: string): string {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

/** Escapes text for a workflow command such as ::warning::. */
function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function command(name: "warning" | "error" | "notice", message: string): void {
  process.stdout.write(`::${name}::${escapeData(message)}\n`);
}

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `pr_trust_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

async function main(): Promise<number> {
  const token = input("github-token");
  if (!token) {
    command("error", "No github-token input. Pass `github-token: ${{ github.token }}`.");
    return 1;
  }
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const gh = createClient({ token, userAgent: "pr-trust-action", log: (m) => console.log(m) });
  const configPath = input("config") || ".github/trust.yml";
  const dryRun = input("dry-run") === "true";

  if (process.env.GITHUB_EVENT_NAME === "issue_comment") {
    const result = await handleComment(gh, { repo, event, configPath, dryRun, log: (m) => console.log(m) });
    const check = result.check;
    setOutput("command", result.outcome === "ignored" ? "" : result.outcome);
    setOutput("status", check?.status ?? (result.outcome === "failed" ? "error" : "skipped"));
    setOutput("reason", result.reason);
    if (check) {
      setOutput("admitted", String(["admitted", "exempt", "skipped"].includes(check.status)));
      setOutput("rule", check.rule ?? "");
    }
    for (const warning of [...result.warnings, ...(check?.warnings ?? [])]) command("warning", warning);
    if (result.outcome === "ignored") return 0;
    if (process.env.GITHUB_STEP_SUMMARY) {
      const lines = [`### /vouch: ${result.outcome}`, "", result.reason, ""];
      if (check) lines.push(summaryMarkdown(`#${event.issue?.number}`, check));
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
    }
    if (result.outcome === "failed") {
      command("error", `/vouch failed: ${result.reason}`);
      return input("fail-on-error") === "true" ? 1 : 0;
    }
    return 0;
  }

  let pr;
  const number = input("pr-number");
  if (number) {
    if (!/^\d+$/.test(number)) {
      command("error", `pr-number must be a number, got "${number}"`);
      return 1;
    }
    const { data } = await gh.rest<Record<string, unknown>>("GET", `/repos/${repo}/pulls/${number}`);
    pr = pullRequestFromApi(repo, data);
  } else if (event.pull_request) {
    pr = pullRequestFromApi(event.pull_request.base?.repo?.full_name ?? repo, event.pull_request);
  } else {
    command("error", "This event has no pull request. Run on pull_request_target or issue_comment, or set the pr-number input.");
    return 1;
  }

  const pretend = input("as-author");
  if (pretend) {
    try {
      pr = asAuthor(pr, pretend);
    } catch (error) {
      command("error", (error as Error).message);
      return 1;
    }
    command("warning", `Checking #${pr.number} as if @${pr.author} had opened it (as-author). Use this only to try out your rules.`);
  }

  const result = await runCheck(gh, {
    pr,
    trigger: { action: event.action ?? null, sender: event.sender?.login ?? null },
    configPath,
    dryRun,
    log: (m) => console.log(m),
  });

  const admitted = ["admitted", "exempt", "skipped"].includes(result.status);
  setOutput("status", result.status);
  setOutput("admitted", String(admitted));
  setOutput("reason", result.reason);
  setOutput("rule", result.rule ?? "");

  console.log(`Result: ${result.status} (${result.reason})`);
  for (const action of result.actions) console.log(`${result.applied ? "Did" : "Would"}: ${describeAction(action)}`);
  for (const warning of result.warnings) command("warning", warning);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(`#${pr.number} by @${pr.author ?? "ghost"}`, result));
  }

  if (result.status === "error") {
    command("error", `Contributor trust check failed: ${result.reason}. The pull request was left open.`);
    return input("fail-on-error") === "true" ? 1 : 0;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    command("error", `pr-trust crashed: ${(error as Error).message}`);
    process.exit(input("fail-on-error") === "true" ? 1 : 0);
  },
);
