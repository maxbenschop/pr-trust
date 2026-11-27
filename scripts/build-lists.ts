/**
 * Builds site/lists.json for the website's trust list directory: for each list in
 * lists/catalog.json, how many people it vouches for, when it last changed, and basic
 * facts about the project. Entries whose list cannot be found are reported and left out.
 *
 *   node scripts/build-lists.ts [--strict]
 */
import fs from "node:fs";
import { VOUCH_FILE_CANDIDATES, isRepoName } from "../src/engine/config.ts";
import { parseVouchFile } from "../src/engine/vouchfile.ts";
import { createClient, resolveToken } from "../src/github/client.ts";

/** `project` names the main repository when the list lives elsewhere, such as an org's .github repo. */
type CatalogEntry = { repo: string; path?: string; project?: string };
type ListInfo = {
  repo: string;
  path: string;
  /** What to write in trust.yml to use this list. */
  ref: string;
  vouched: number;
  denounced: number;
  updatedAt: string | null;
  stars: number;
  description: string | null;
  language: string | null;
  url: string;
};

type RepoData = {
  repository: {
    url: string;
    stargazerCount: number;
    description: string | null;
    isArchived: boolean;
    primaryLanguage: { name: string } | null;
    [alias: string]: unknown;
  } | null;
};

const catalog: CatalogEntry[] = JSON.parse(fs.readFileSync("lists/catalog.json", "utf8"));
const gh = createClient({ token: resolveToken(), userAgent: "pr-trust-lists" });
const lists: ListInfo[] = [];
const problems: string[] = [];

for (const entry of catalog) {
  if (!isRepoName(entry.repo)) {
    problems.push(`${entry.repo}: not a repository name`);
    continue;
  }
  const [owner, name] = entry.repo.split("/") as [string, string];
  const paths = entry.path ? [entry.path] : VOUCH_FILE_CANDIDATES;
  const fields = paths
    .map(
      (p, i) => `
    f${i}: object(expression: ${JSON.stringify(`HEAD:${p}`)}) { ... on Blob { text } }
    h${i}: defaultBranchRef { target { ... on Commit { history(path: ${JSON.stringify(p)}, first: 1) { nodes { committedDate } } } } }`,
    )
    .join("");
  const data = await gh.graphql<RepoData>(
    `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    url stargazerCount description isArchived primaryLanguage { name }${fields}
  }
}`,
    { owner, name },
  );
  const repo = data.repository;
  if (!repo) {
    problems.push(`${entry.repo}: repository not found`);
    continue;
  }
  if (repo.isArchived) {
    problems.push(`${entry.repo}: archived`);
    continue;
  }
  const index = paths.findIndex((_, i) => (repo[`f${i}`] as { text?: string } | null)?.text != null);
  if (index === -1) {
    problems.push(`${entry.repo}: no VOUCHED.td found`);
    continue;
  }
  const list = parseVouchFile((repo[`f${index}`] as { text: string }).text);
  const history = repo[`h${index}`] as { target: { history: { nodes: { committedDate: string }[] } } } | null;
  const path = paths[index]!;
  // Show the main project's details when the list lives in a side repository.
  let shown = { url: repo.url, stars: repo.stargazerCount, description: repo.description, language: repo.primaryLanguage?.name ?? null };
  if (entry.project && isRepoName(entry.project)) {
    const [pOwner, pName] = entry.project.split("/") as [string, string];
    const p = await gh.graphql<RepoData>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { url stargazerCount description isArchived primaryLanguage { name } } }`,
      { owner: pOwner, name: pName },
    );
    if (p.repository) {
      shown = {
        url: p.repository.url,
        stars: p.repository.stargazerCount,
        description: p.repository.description,
        language: p.repository.primaryLanguage?.name ?? null,
      };
    }
  }
  lists.push({
    repo: entry.project ?? entry.repo,
    path,
    ref: entry.path ? `${entry.repo}:${path}` : entry.repo,
    vouched: list.vouched.size,
    denounced: list.denounced.size,
    updatedAt: history?.target.history.nodes[0]?.committedDate ?? null,
    ...shown,
  });
}

lists.sort((a, b) => b.stars - a.stars);
fs.mkdirSync("site", { recursive: true });
fs.writeFileSync("site/lists.json", JSON.stringify({ generatedAt: new Date().toISOString(), lists }, null, 2) + "\n");
console.log(`Wrote ${lists.length} lists to site/lists.json`);
for (const p of problems) console.warn(`skipped ${p}`);
if (problems.length > 0 && process.argv.includes("--strict")) process.exit(1);
