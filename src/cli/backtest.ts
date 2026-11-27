import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadBacktestData } from "../backtest/load.ts";
import { historicalSources } from "../backtest/history.ts";
import { replay } from "../backtest/replay.ts";
import { renderComparison, renderSummary, summarize, type Summary } from "../backtest/report.ts";
import { ConfigError, DEFAULT_CONFIG_YAML, isRepoName, parseConfig } from "../engine/config.ts";
import { createDiskCache } from "../github/cache.ts";
import { createClient, resolveToken } from "../github/client.ts";

const USAGE = `Replay a year of pull requests against contributor-trust rules.

Usage: pnpm backtest <owner/repo>... [options]

Options:
  --config <file>   Rules to test (default: own Vouch list + 1 merged PR in the repo within 24 months)
  --until <date>    End of the window, YYYY-MM-DD (default: today, UTC)
  --days <n>        Length of the window in days (default: 365)
  --json <file>     Also write the summaries and every PR's decision as JSON
  --refresh         Ignore cached GitHub responses (still writes the cache)
  --quiet           No progress output
  -h, --help        Show this help

Auth: GITHUB_TOKEN, GH_TOKEN, or the GitHub CLI's login. Responses are cached in .cache/.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      until: { type: "string" },
      days: { type: "string", default: "365" },
      json: { type: "string" },
      refresh: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const bad = positionals.filter((p) => !isRepoName(p));
  if (bad.length > 0) return fail(`Not a repository name: ${bad.join(", ")} (expected owner/repo)`);

  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1) return fail("--days must be a positive whole number");
  const to = values.until ? new Date(`${values.until}T00:00:00Z`) : startOfTodayUtc();
  if (Number.isNaN(to.getTime())) return fail("--until must be a date like 2026-11-27");
  const from = new Date(to.getTime() - days * 86_400_000);

  const configText = values.config ? fs.readFileSync(values.config, "utf8") : DEFAULT_CONFIG_YAML;
  const config = parseConfig(configText);

  const log = values.quiet ? () => {} : (m: string) => process.stderr.write(`${m}\n`);
  const gh = createClient({
    token: resolveToken(),
    cache: createDiskCache(path.resolve(".cache/github"), { refresh: values.refresh }),
    log,
  });

  const summaries: Summary[] = [];
  const results: unknown[] = [];
  for (const repo of positionals) {
    const data = await loadBacktestData(gh, { repo, config, from, to, log });
    const rows = await replay(data.prs, config, historicalSources(data), repo, data.maintainers);
    const summary = summarize({ repo, from, to, config, ownListPath: data.own?.path ?? null, rows, notes: data.notes });
    summaries.push(summary);
    results.push({
      summary,
      prs: rows.map((r) => ({
        number: r.pr.number,
        author: r.pr.author,
        createdAt: r.pr.createdAt,
        association: r.pr.association,
        group: r.group,
        outcome: r.outcome,
        decision: r.decision,
      })),
    });
    log("");
    console.log(renderSummary(summary));
    console.log("");
  }

  if (summaries.length > 1) {
    console.log("Comparison");
    console.log(renderComparison(summaries));
    console.log("");
  }

  if (values.json) {
    fs.mkdirSync(path.dirname(path.resolve(values.json)), { recursive: true });
    fs.writeFileSync(values.json, JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    log(`wrote ${values.json}`);
  }
  log(`GitHub requests: ${gh.stats.requests} (plus ${gh.stats.cached} from cache)`);
  return 0;
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : `Error: ${(error as Error).message}`);
    process.exit(1);
  },
);
