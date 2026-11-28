import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateRules } from "../src/action/validate.ts";
import { didYouMean } from "../src/engine/config.ts";
import { formatFinding, formatPath, lintConfig, summaryLine, type Finding } from "../src/engine/lint.ts";
import { GitHubError, type GraphQLClient } from "../src/github/client.ts";

/** Each finding as "level line: message", which is what a maintainer reads. */
const brief = (findings: Finding[]) => findings.map((f) => `${f.level} ${f.line}: ${f.message}`);
const warnings = (text: string) => lintConfig(text).findings.filter((f) => f.level === "warning").map((f) => f.message);

describe("lintConfig errors", () => {
  it("reports every parser problem with its line and a hint for near misses", () => {
    const { config, findings } = lintConfig(`own-list: auto
admits:
  - list: a/b
admit:
  - ghostty-org/ghostty
  - list: https://github.com/ghostty-org/ghostty
  - merged:
    repo: self
  - merged: { repo: self, within: 24m, minimum: 2 }
  - merge: { repo: self }
  - vouched: x/y
on_unknown: closed
labels: { unknwn: x }
`);
    expect(config).toBeNull();
    expect(brief(findings)).toEqual([
      'error 1: unknown key "own-list" (did you mean "own_list"?)',
      'error 2: unknown key "admits" (did you mean "admit"?)',
      'error 5: admit[0] must be a rule; to trust ghostty-org/ghostty\'s Vouch list, write "- list: ghostty-org/ghostty"',
      'error 6: admit[1].list must be "owner/repo" or "owner/repo:path/to/VOUCHED.td" (did you mean "ghostty-org/ghostty"?)',
      'error 7: admit[2] must have exactly one key ("list", "merged" or "org_member"); repo belongs inside it: indent it further than merged:, or write merged: { repo: self, min: 1, within: 24mo }',
      'error 9: admit[3].merged: unknown key "minimum" (did you mean "min"?)',
      'error 9: admit[3].merged.within must look like 90d, 12w, 24mo or 2y (did you mean "24mo"?)',
      'error 10: admit[4] has unknown rule "merge" (did you mean "merged"?)',
      'error 11: admit[5] has unknown rule "vouched" (expected "list", "merged" or "org_member")',
      'error 12: on_unknown must be "label" or "close" (did you mean "close"?)',
      'error 13: labels: unknown key "unknwn" (did you mean "unknown"?)',
    ]);
    expect(formatPath(findings[6]!.path)).toBe("admit[3].merged.within");
  });

  it("points at the line of a YAML syntax error", () => {
    const { findings } = lintConfig("admit:\n  - list: a/b\n  bad: [\n");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: "error", line: 3, path: [] });
    expect(findings[0]!.message).toMatch(/^not valid YAML: /);
  });

  it("reports a duplicate key as an error", () => {
    expect(brief(lintConfig("on_unknown: label\non_unknown: close\n").findings)[0]).toMatch(/^error 2: not valid YAML: Map keys must be unique/);
  });

  it("does not suggest unrelated names", () => {
    expect(didYouMean("colour", ["comment", "labels", "admit"])).toBe("");
    expect(didYouMean("max", ["min"])).toBe("");
    expect(didYouMean("Exempt-Paths", ["exempt_paths"])).toBe(' (did you mean "exempt_paths"?)');
    expect(didYouMean("exempt", ["exempt_paths", "admit"])).toBe(' (did you mean "exempt_paths"?)');
  });
});

describe("lintConfig warnings", () => {
  it("has none for the shipped rules files", () => {
    for (const file of [".github/trust.yml", "examples/trust.yml", "examples/strict.yml"]) {
      expect(lintConfig(fs.readFileSync(file, "utf8")).findings, file).toEqual([]);
    }
  });

  it("warns when on_unknown: close leaves no way to be admitted", () => {
    expect(warnings("own_list: none\non_unknown: close\n")).toEqual([
      expect.stringMatching(/^on_unknown is close, but with own_list: none and no admit rules nobody can be admitted/),
    ]);
    expect(lintConfig("own_list: none\non_unknown: close\n").findings[0]!.line).toBe(2);
    // Someone can still be vouched into the own list, or admitted by a rule, or it only labels.
    expect(warnings("on_unknown: close\n")).toEqual([]);
    expect(warnings("own_list: none\non_unknown: close\nadmit:\n  - list: a/b\n")).toEqual([]);
    expect(warnings("own_list: none\non_unknown: label\n")).toEqual([]);
  });

  it("warns about the account age floor and merges anywhere", () => {
    expect(warnings("min_account_age: 30d\n")).toEqual([expect.stringMatching(/^min_account_age has no effect without admit rules/)]);
    const { findings } = lintConfig("admit:\n  - org_member: a\n  - merged: { repo: any, min: 2 }\n  - org_member: A\n");
    expect(brief(findings)).toEqual([
      "warning 4: admit[2] repeats admit[0] (public member of A); remove one of them",
      expect.stringMatching(/^warning 3: admit\[1\] counts merges anywhere on GitHub, .* add min_account_age \(such as min_account_age: 30d\)/),
    ]);
    expect(warnings("min_account_age: 30d\nadmit:\n  - merged: { repo: any, min: 2 }\n  - merged: { repo: any, min: 2, within: 24mo }\n")).toEqual([
      "admit[1] repeats admit[0] (≥2 merged PRs in others' public repos within 24 months); remove one of them",
    ]);
  });

  it("warns about repeated and redundant rules", () => {
    const { findings } = lintConfig(`admit:
  - list: a/b
  - list: A/B
  - list: a/b:other/VOUCHED.td
  - merged: { repo: self, min: 1, within: 24mo }
  - merged: { repo: self, min: 1, within: 2y }
  - merged: { repo: self, min: 3, within: 12mo }
  - merged: { repo: x/y, min: 3, within: 12mo }
  - merged: { repo: x/y, min: 1, within: 36mo }
`);
    expect(brief(findings)).toEqual([
      "warning 3: admit[1] repeats admit[0] (vouched in A/B); remove one of them",
      "warning 6: admit[4] repeats admit[3] (≥1 merged PR in this repo within 2 years); remove one of them",
      "warning 7: admit[5] (≥3 merged PRs in this repo within 12 months) never admits anyone: admit[3] (≥1 merged PR in this repo within 24 months) already admits everyone it would. Remove it, or make admit[3] stricter",
      "warning 8: admit[6] (≥3 merged PRs in x/y within 12 months) never admits anyone: admit[7] (≥1 merged PR in x/y within 36 months) already admits everyone it would. Remove it, or make admit[7] stricter",
    ]);
    // A stricter count over a longer window admits people the other rule does not.
    expect(warnings("admit:\n  - merged: { repo: self, min: 1, within: 6mo }\n  - merged: { repo: self, min: 3, within: 24mo }\n")).toEqual([]);
  });

  it("warns about a merged window of days", () => {
    const { findings } = lintConfig("admit:\n  - merged: { repo: self, within: 24d }\n");
    expect(brief(findings)).toEqual([
      "warning 2: admit[0].merged.within is only 24 days: only authors with a pull request merged that recently pass. For months, write mo, as in 24mo",
    ]);
    expect(warnings("admit:\n  - merged: { repo: self, within: 4w }\n  - merged: { repo: x/y, within: 90d }\n")).toEqual([]);
  });

  it("warns about exempt_paths that match nearly everything or nothing", () => {
    expect(warnings('exempt_paths: ["**", "**/*.*", "*", "docs/**", "/docs/**", "./README.md"]\n')).toEqual([
      'exempt_paths pattern "**" matches nearly every file (such as src/main.rs and package.json), so almost every pull request skips the check',
      'exempt_paths pattern "**/*.*" matches nearly every file (such as src/main.rs and package.json), so almost every pull request skips the check',
      'exempt_paths pattern "/docs/**" never matches: changed files are named from the repository root, without a leading "/" or "./" (write "docs/**")',
      'exempt_paths pattern "./README.md" never matches: changed files are named from the repository root, without a leading "/" or "./" (write "README.md")',
    ]);
  });

  it("warns about own_list and message_file paths that are never found", () => {
    expect(warnings("own_list: ./VOUCHED.td\nmessage_file: /.github/msg.md\n")).toEqual([
      'own_list "./VOUCHED.td" is never found: write the path from the repository root, without a leading "/" or "./" and without "..", as in .github/VOUCHED.td',
      'message_file "/.github/msg.md" is never found: write the path from the repository root, without a leading "/" or "./" and without "..", as in .github/trust-message.md',
    ]);
  });

  it("warns about labels that collide, ignoring case, but not about labels turned off", () => {
    const { findings } = lintConfig('labels:\n  admitted: ""\n  unknown: ""\n  error: "Trust: Denounced"\n');
    expect(brief(findings)).toEqual([
      'warning 4: labels.error and labels.denounced are both "Trust: Denounced" (GitHub ignores case in label names), so that label cannot tell the two results apart',
    ]);
  });

  it("formats findings and the summary line", () => {
    const finding: Finding = { level: "warning", message: "x", path: ["admit", 0], line: 3 };
    expect(formatFinding("trust.yml", finding)).toBe("trust.yml:3: warning: x");
    expect(formatFinding("trust.yml", { ...finding, line: null })).toBe("trust.yml: warning: x");
    expect(summaryLine("trust.yml", [finding, { ...finding, level: "error" }], "offline")).toBe("trust.yml: 1 error, 1 warning (offline)");
    expect(summaryLine("trust.yml", [], "offline")).toBe("trust.yml: no problems found (offline)");
  });
});

describe("pr-trust validate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-trust-validate-"));
  const write = (name: string, text: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };
  // No token in the environment: the offline command must not need one.
  const run = (...args: string[]) => {
    const env = { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" };
    const result = spawnSync(process.execPath, ["src/cli/main.ts", "validate", ...args], { encoding: "utf8", env });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const good = write("good.yml", "admit:\n  - merged: { repo: self }\n");
  const warned = write("warned.yml", "admit:\n  - merged: { repo: self, within: 7d }\n");
  const broken = write("broken.yml", "admits: []\n");

  it("exits 0 with no problems and prints a summary", () => {
    const { code, out } = run(good);
    expect(code).toBe(0);
    expect(out).toBe(`${good}: no problems found (offline checks; add --online to check on GitHub)\n`);
  });

  it("exits 0 on warnings, or 1 with --strict", () => {
    expect(run(warned)).toMatchObject({ code: 0, out: expect.stringContaining(`${warned}:2: warning: admit[0].merged.within is only 7 days`) });
    expect(run(warned).out).toMatch(/: 1 warning \(offline checks/);
    expect(run(warned, "--strict").code).toBe(1);
  });

  it("exits 1 on errors", () => {
    const { code, out } = run(broken);
    expect(code).toBe(1);
    expect(out).toContain(`${broken}:1: error: unknown key "admits" (did you mean "admit"?)`);
    expect(out).toContain(`${broken}: 1 error (offline checks`);
  });

  it("exits 2 when the file cannot be read or the arguments are wrong", () => {
    expect(run(path.join(dir, "missing.yml"))).toMatchObject({ code: 2, err: expect.stringContaining("Cannot read") });
    expect(run(good, "--repo", "a/b").code).toBe(2);
    expect(run("--help").code).toBe(0);
  });

  it("prints JSON with --json", () => {
    const { code, out } = run(warned, "--json", "--strict");
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({
      file: warned,
      ok: false,
      errors: 0,
      warnings: 1,
      online: false,
      findings: [
        {
          level: "warning",
          message: expect.stringMatching(/^admit\[0\]\.merged\.within is only 7 days/),
          path: "admit[0].merged.within",
          line: 2,
        },
      ],
      notes: [],
    });
  });
});

describe("the Action's validate input", () => {
  it("refuses to read a pull request's file under pull_request_target", () => {
    const env = {
      ...process.env,
      "INPUT_GITHUB-TOKEN": "not-a-real-token",
      INPUT_VALIDATE: ".github/trust.yml",
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_REPOSITORY: "me/project",
      GITHUB_SHA: "abc123",
      GITHUB_EVENT_PATH: "",
      GITHUB_OUTPUT: "",
      GITHUB_STEP_SUMMARY: "",
    };
    const result = spawnSync(process.execPath, ["src/action/main.ts"], { encoding: "utf8", env });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^::error::validate reads a file from the pull request, so run it on the pull_request event/);
  });
});

/** A fake GitHub for the online checks: repositories (with renames), files and the search index. */
function fakeGitHub(world: {
  repos: Record<string, string>; // name as written -> current name; anything else does not exist
  files?: Record<string, string>; // "owner/repo:path" -> text
  unsearchable?: string[];
  orgs?: string[];
}) {
  const refs: string[] = [];
  const current = (name: string) => {
    const found = Object.entries(world.repos).find(([k, v]) => [k, v].some((n) => n.toLowerCase() === name.toLowerCase()));
    if (!found) throw new GitHubError(`GitHub GraphQL error: Could not resolve to a Repository with the name '${name}'.`);
    return found[1];
  };
  const gh: GraphQLClient = {
    stats: { requests: 0, cached: 0 },
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      if (query.includes("search(")) {
        const repo = /repo:(\S+)/.exec(variables.q as string)![1]!;
        return { search: { issueCount: world.unsearchable?.includes(repo) ? 0 : 7 } } as T;
      }
      if (query.includes("organization(")) {
        const org = world.orgs?.find((o) => o.toLowerCase() === String(variables.login).toLowerCase());
        if (!org) throw new GitHubError(`GitHub GraphQL error: Could not resolve to an Organization with the login of '${variables.login}'.`);
        return { organization: { login: org } } as T;
      }
      const repo = current(`${variables.owner}/${variables.name}`);
      if (query.includes("nameWithOwner")) return { repository: { nameWithOwner: repo } } as T;
      const repository: Record<string, unknown> = {};
      for (const [, alias, ref, file] of query.matchAll(/(f\d+): object\(expression: "([^:"]+):([^"]+)"\)/g)) {
        refs.push(`${repo}@${ref}:${file}`);
        const text = world.files?.[`${repo}:${file}`];
        repository[alias!] = text === undefined ? null : { text };
      }
      return { repository } as T;
    },
  };
  return { gh, refs };
}

describe("validateRules online: rules about the author", () => {
  it("checks that organisations exist and leaves merges anywhere alone", async () => {
    const { gh } = fakeGitHub({ repos: {}, orgs: ["rust-lang"] });
    const result = await validateRules(
      "own_list: none\nmin_account_age: 30d\nadmit:\n  - org_member: rust-lang\n  - org_member: no-such-org\n  - merged: { repo: any, min: 2 }\n",
      { gh, repo: null },
    );
    expect(brief(result.findings)).toEqual(["error 5: no-such-org is not a GitHub organisation, so admit[1] admits no one"]);
  });
});

describe("validateRules online", () => {
  const rules = `own_list: .github/VOUCHED.td
admit:
  - list: old/lists
  - list: gone/away
  - list: no/list
  - list: empty/list
  - list: ok/list:people.td
  - merged: { repo: facebook/react, min: 3 }
  - merged: { repo: hidden/repo }
  - merged: { repo: self }
message_file: .github/msg.md
`;
  const world = {
    repos: {
      "me/project": "me/project",
      "old/lists": "new/lists",
      "no/list": "no/list",
      "empty/list": "empty/list",
      "ok/list": "ok/list",
      "facebook/react": "react/react",
      "hidden/repo": "hidden/repo",
    },
    files: {
      "new/lists:.github/VOUCHED.td": "alice\n",
      "empty/list:VOUCHED.td": "# nobody yet\n-mallory\n",
      "ok/list:people.td": "bob\n",
      "me/project:.github/msg.md": "Hi {author}, {reson}. {next} Code: `{x}`\n",
    },
    unsearchable: ["hidden/repo"],
  };

  it("reports missing repositories and lists as errors, and renames and gaps as warnings", async () => {
    const { gh } = fakeGitHub(world);
    const result = await validateRules(rules, { gh, repo: "me/project" });
    expect(result.online).toBe(true);
    expect(brief(result.findings)).toEqual([
      "warning 1: .github/VOUCHED.td does not exist in me/project on the default branch. Until it does, every check warns that the list is missing (the first /vouch creates it)",
      'warning 3: old/lists is now new/lists. The rule still works, but update it to "list: new/lists"',
      "error 4: gone/away does not exist, or this token cannot read it, so admit[1] admits no one",
      "error 5: no/list has no Vouch list at .github/VOUCHED.td or VOUCHED.td on its default branch, so admit[2] admits no one",
      "warning 6: the Vouch list in empty/list vouches for no one yet, so admit[3] admits no one for now",
      'warning 8: facebook/react is now react/react. GitHub search does not follow renames, so the Action looks up the new name on every check; update the rule to "repo: react/react"',
      "warning 9: hidden/repo is not in GitHub's search index, so the Action counts each author's own merged pull requests instead, reading at most 500 per author, which is slower and can miss merges by very active authors",
      "warning 11: .github/msg.md uses {reson}, which is not a placeholder and is shown as written (did you mean {reason}?). Placeholders: {author}, {reason}, {repo}, {next}, {rules}, {alert}",
      "warning 11: .github/msg.md uses {x}, which is not a placeholder and is shown as written. Placeholders: {author}, {reason}, {repo}, {next}, {rules}, {alert}",
    ]);
    expect(result.notes).toEqual([]);
  });

  it("reads own_list and message_file at the given commit", async () => {
    const { gh, refs } = fakeGitHub({ ...world, files: {} });
    const result = await validateRules("message_file: m.md\n", { gh, repo: "me/project", ref: "abc123", refName: "in this pull request" });
    expect(refs).toEqual(["me/project@abc123:.github/VOUCHED.td", "me/project@abc123:VOUCHED.td", "me/project@abc123:m.md"]);
    // A missing list under own_list: auto is normal; a missing message file is not.
    expect(brief(result.findings)).toEqual([
      "warning 1: m.md does not exist in me/project in this pull request, so the default message is used",
    ]);
  });

  it("skips what needs the repository when none is given, and says so", async () => {
    const { gh, refs } = fakeGitHub(world);
    const result = await validateRules("admit:\n  - merged: { repo: self }\nmessage_file: m.md\n", { gh, repo: null });
    expect(result.findings).toEqual([]);
    expect(refs).toEqual([]);
    expect(result.notes).toEqual(['No repository given, so merged rules on "self", own_list and message_file were not checked online.']);
  });

  it("reports a repository that does not exist", async () => {
    const { gh } = fakeGitHub(world);
    const result = await validateRules("admit:\n  - merged: { repo: self }\n", { gh, repo: "me/typo" });
    expect(brief(result.findings)).toEqual([
      'error null: me/typo does not exist, or this token cannot read it, so its own list, message file and merged rules on "self" were not checked',
    ]);
  });

  it("does not go online until the errors are fixed", async () => {
    const { gh, refs } = fakeGitHub(world);
    const result = await validateRules("admits: []\n", { gh, repo: "me/project" });
    expect(result.findings.map((f) => f.level)).toEqual(["error"]);
    expect(refs).toEqual([]);
    expect(result.notes).toEqual(["The online checks run once the errors above are fixed."]);
  });

  it("lets other GitHub failures through instead of calling the rules wrong", async () => {
    const gh: GraphQLClient = {
      stats: { requests: 0, cached: 0 },
      graphql: async () => {
        throw new GitHubError("GitHub API 502: Bad Gateway", 502);
      },
    };
    await expect(validateRules("admit:\n  - list: a/b\n", { gh, repo: null })).rejects.toThrow("502");
  });
});
