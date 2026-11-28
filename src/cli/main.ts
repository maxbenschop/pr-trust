/**
 * The `pr-trust` command: `pr-trust check owner/repo#123`, `pr-trust backtest owner/repo`
 * or `pr-trust validate .github/trust.yml`.
 * Bundled to dist/cli.cjs so it runs from `npx github:maxbenschop/pr-trust`.
 */
const USAGE = `pr-trust: contributor trust checks for pull requests

Usage:
  pr-trust check <owner/repo#number> [--config rules.yml]   Decide one PR, change nothing
  pr-trust backtest <owner/repo>... [--config rules.yml]    Replay a year of PRs against rules
  pr-trust validate [file] [--online --repo owner/repo]     Find mistakes in a rules file

Run each command with --help for its options.
Docs: https://maxbenschop.github.io/pr-trust/docs/
Another GitHub server: set GH_HOST=github.example.com`;

const command = process.argv[2];
// Each command parses process.argv itself, so drop the command name first.
process.argv.splice(2, 1);

if (command === "check") await import("./check.ts");
else if (command === "backtest") await import("./backtest.ts");
else if (command === "validate") await import("./validate.ts");
else {
  console.log(USAGE);
  process.exit(command === undefined || command === "--help" || command === "-h" ? 0 : 1);
}
