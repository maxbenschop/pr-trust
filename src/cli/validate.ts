import fs from "node:fs";
import { parseArgs } from "node:util";
import { validateRules } from "../action/validate.ts";
import { isRepoName } from "../engine/config.ts";
import { countFindings, formatFinding, formatPath, summaryLine } from "../engine/lint.ts";
import { createClient, resolveToken } from "../github/client.ts";

const USAGE = `Check a rules file for mistakes before it is merged. Nothing is written anywhere.

Usage: pr-trust validate [file] [options]     (file defaults to .github/trust.yml)

It parses the file exactly as the Action does and lists every error, then warns about
settings that are valid but probably not meant: nobody can be admitted under
on_unknown: close, repeated or redundant rules, a merged window of days instead of
months, exempt_paths that match almost everything or nothing, colliding labels.

Options:
  --online              Also check on GitHub that each repository a rule names exists
                        (and whether it was renamed), that each list: rule finds a Vouch
                        list, and that merged rules' repositories are in the search index.
                        Needs a token: GITHUB_TOKEN, GH_TOKEN, or \`gh auth login\`.
  --repo <owner/repo>   With --online: the repository the rules are for. Resolves "self"
                        and checks own_list and message_file on its default branch.
  --strict              Fail on warnings too
  --json                Print the findings as JSON
  -h, --help            Show this help

Exit status: 0 when there are no errors (or, with --strict, no warnings either),
1 when there are, 2 when the file or GitHub could not be read.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      online: { type: "boolean", default: false },
      repo: { type: "string" },
      strict: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length > 1) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (values.repo !== undefined && !isRepoName(values.repo)) return fail(`--repo must be owner/repo, got "${values.repo}"`);
  if (values.repo !== undefined && !values.online) return fail("--repo is only used with --online");

  const file = positionals[0] ?? ".github/trust.yml";
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return fail(`Cannot read ${file}: ${(error as Error).message}`);
  }

  const online = values.online
    ? { gh: createClient({ token: resolveToken() }), repo: values.repo ?? null }
    : undefined;
  const result = await validateRules(text, online);
  const { errors, warnings } = countFindings(result.findings);
  const code = errors > 0 || (values.strict && warnings > 0) ? 1 : 0;

  if (values.json) {
    const findings = result.findings.map((f) => ({ ...f, path: formatPath(f.path) || null }));
    console.log(JSON.stringify({ file, ok: code === 0, errors, warnings, online: result.online, findings, notes: result.notes }, null, 2));
    return code;
  }
  for (const finding of result.findings) console.log(formatFinding(file, finding));
  for (const note of result.notes) console.log(`note: ${note}`);
  console.log(summaryLine(file, result.findings, result.online ? "offline and online checks" : "offline checks; add --online to check on GitHub"));
  return code;
}

function fail(message: string): number {
  console.error(message);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(2);
  },
);
