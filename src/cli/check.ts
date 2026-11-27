import fs from "node:fs";
import { parseArgs } from "node:util";
import { pullRequestFromApi, runCheck } from "../action/check.ts";
import { ConfigError, isRepoName } from "../engine/config.ts";
import { createClient, resolveToken } from "../github/client.ts";

const USAGE = `Run the contributor trust check on one pull request, without changing anything.

Usage: pnpm check <owner/repo#number> [options]

Options:
  --config <file>   Local rules file to try (default: the repo's .github/trust.yml, else built-in defaults)
  --json            Print the result as JSON
  -h, --help        Show this help

It prints the decision and what the Action would do. Nothing is written to GitHub.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const match = /^([^#\s]+)#(\d+)$/.exec(positionals[0]!);
  if (!match || !isRepoName(match[1]!)) {
    console.error("Expected a pull request like owner/repo#123");
    return 1;
  }
  const [, repo, number] = match as unknown as [string, string, string];

  const gh = createClient({ token: resolveToken() });
  const { data } = await gh.rest<Record<string, unknown>>("GET", `/repos/${repo}/pulls/${number}`);
  const pr = pullRequestFromApi(repo, data);
  const result = await runCheck(gh, {
    pr,
    trigger: { action: null, sender: null },
    configPath: ".github/trust.yml",
    configText: values.config ? fs.readFileSync(values.config, "utf8") : null,
    dryRun: true,
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`${repo}#${number} by ${pr.author ?? "a deleted account"}`);
  console.log(`Result: ${result.status} (${result.reason})`);
  console.log(`Rules:  ${result.configSource}`);
  if (result.actions.length === 0) console.log("Would do nothing.");
  for (const action of result.actions) {
    if (action.kind === "add-label") console.log(`Would add label "${action.label}"`);
    else if (action.kind === "remove-label") console.log(`Would remove label "${action.label}"`);
    else if (action.kind === "close") console.log("Would close the pull request");
    else {
      console.log(action.kind === "comment" ? "Would comment:" : "Would update its earlier comment, if any, to:");
      console.log(action.body.replace(/^<!--.*-->\n/, "").replace(/^/gm, "  | "));
    }
  }
  for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : `Error: ${(error as Error).message}`);
    process.exit(1);
  },
);
