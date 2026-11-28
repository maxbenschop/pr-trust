/**
 * GitHub Action entry point. Reads the event and inputs from the runner's environment,
 * runs the check and reports through outputs, annotations and the job summary.
 * Inputs: github-token, config, dry-run, pr-number, as-author, fail-on-error, validate.
 * On an `issue_comment` event it handles the `/vouch` command instead (see vouch.ts), and
 * on a `push` that changed the trust list it checks waiting pull requests again (recheck.ts).
 * With the `validate` input it only checks a rules file and changes nothing (validate.ts).
 */
import fs from "node:fs";
import { countFindings, summaryLine } from "../engine/lint.ts";
import { createClient, type GitHubClient } from "../github/client.ts";
import { asAuthor, pullRequestFromApi, runCheck } from "./check.ts";
import { readFilesAt } from "./live.ts";
import { handlePush } from "./recheck.ts";
import { describeAction, summaryMarkdown } from "./report.ts";
import { validateRules } from "./validate.ts";
import { handleComment } from "./vouch.ts";

function input(name: string): string {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

/** Escapes text for a workflow command such as ::warning::. */
function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escapes a workflow command property, such as file=. */
function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function command(name: "warning" | "error" | "notice", message: string, where?: { file: string; line: number | null }): void {
  const properties = where ? ` file=${escapeProperty(where.file)}${where.line ? `,line=${where.line}` : ""}` : "";
  process.stdout.write(`::${name}${properties}::${escapeData(message)}\n`);
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
  if (gh.endpoints && !gh.endpoints.dotcom) console.log(`Using the GitHub server at ${gh.endpoints.server}`);
  const configPath = input("config") || ".github/trust.yml";
  const dryRun = input("dry-run") === "true";

  const validate = input("validate");
  if (validate) return validateFile(gh, repo, validate);

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

  const number = input("pr-number");
  if (process.env.GITHUB_EVENT_NAME === "push" && !number) {
    let result;
    try {
      result = await handlePush(gh, { repo, event, configPath, dryRun, log: (m) => console.log(m) });
    } catch (error) {
      command("error", `Checking waiting pull requests again failed: ${(error as Error).message}`);
      return input("fail-on-error") === "true" ? 1 : 0;
    }
    setOutput("status", "skipped");
    setOutput("reason", result.reason);
    setOutput("rechecked", result.checks.map((c) => c.number).join(","));
    console.log(`Result: ${result.reason}`);
    for (const warning of [...result.warnings, ...result.checks.flatMap((c) => c.result.warnings)]) command("warning", warning);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const lines = ["### Trust list changed", "", result.reason, ""];
      for (const { number: n, result: check } of result.checks) lines.push(summaryMarkdown(`#${n}`, check));
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
    }
    const failures = result.failed.length + result.checks.filter((c) => c.result.status === "error").length;
    if (failures > 0) {
      command("error", `${failures} pull request${failures === 1 ? "" : "s"} could not be checked again. They were left open.`);
      return input("fail-on-error") === "true" ? 1 : 0;
    }
    return 0;
  }

  let pr;
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
    command("error", "This event has no pull request. Run on pull_request_target, issue_comment or push, or set the pr-number input.");
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

/**
 * Checks the rules file as of the commit the workflow runs on (for `pull_request`, the pull
 * request merged into its base), read through the API as data: nothing is checked out and
 * nothing from the pull request runs. Fails the job on errors; warnings only annotate.
 */
async function validateFile(gh: GitHubClient, repo: string, file: string): Promise<number> {
  const event = process.env.GITHUB_EVENT_NAME;
  if (event === "pull_request_target") {
    command(
      "error",
      "validate reads a file from the pull request, so run it on the pull_request event with a read-only token, " +
        "not on pull_request_target. See examples/validate-rules.yml.",
    );
    return 1;
  }
  const sha = process.env.GITHUB_SHA;
  if (!sha) {
    command("error", "GITHUB_SHA is not set, so there is no commit to read the rules file from.");
    return 1;
  }
  const refName = event === "pull_request" ? "in this pull request" : `at commit ${sha.slice(0, 7)}`;
  let text: string | null | undefined;
  let result;
  try {
    [text] = await readFilesAt(gh, repo, sha, [file]);
    if (text == null) {
      command("notice", `There is no ${file} ${refName}, so the Action would use its built-in defaults.`);
      setOutput("status", "valid");
      return 0;
    }
    result = await validateRules(text, { gh, repo, ref: sha, refName });
  } catch (error) {
    command("error", `Could not validate ${file}: ${(error as Error).message}`);
    return 1;
  }
  // Messages quote the file, which the pull request controls, so they only go out escaped
  // in workflow commands: printed as is, a line starting with "::" would be a command.
  for (const finding of result.findings) command(finding.level, finding.message, { file, line: finding.line });
  for (const note of result.notes) console.log(`note: ${note}`);
  const summary = summaryLine(file, result.findings, `checked ${refName}`);
  console.log(summary);
  const { errors } = countFindings(result.findings);
  setOutput("status", errors > 0 ? "invalid" : "valid");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### Rules file: ${errors > 0 ? "invalid" : "valid"}`, "", summary, ""];
    for (const f of result.findings) lines.push(`- **${f.level}**${f.line ? ` (line ${f.line})` : ""}: ${f.message.replace(/\n[\s\S]*/, "")}`);
    if (result.findings.length > 0) lines.push("");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  return errors > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    command("error", `pr-trust crashed: ${(error as Error).message}`);
    process.exit(input("fail-on-error") === "true" ? 1 : 0);
  },
);
