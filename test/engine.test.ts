import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_LABELS, describeRule, parseConfig, parseListRef } from "../src/engine/config.ts";
import { parseDuration, subtractDuration } from "../src/engine/duration.ts";
import { evaluate, type TrustSources } from "../src/engine/rules.ts";
import { addVouch, NEW_VOUCH_FILE_HEADER, parseVouchFile } from "../src/engine/vouchfile.ts";

describe("parseVouchFile", () => {
  it("reads vouched and denounced GitHub users, ignoring comments and other platforms", () => {
    const list = parseVouchFile(`# trusted
mitchellh
github:Alice details here
@bob
-github:mallory submitted slop
gitlab:carol
`);
    expect([...list.vouched].sort()).toEqual(["alice", "bob", "mitchellh"]);
    expect([...list.denounced]).toEqual(["mallory"]);
  });

  it("lets a denouncement win over a vouch for the same login", () => {
    const list = parseVouchFile("eve\n-eve\n");
    expect(list.vouched.has("eve")).toBe(false);
    expect(list.denounced.has("eve")).toBe(true);
  });
});

describe("addVouch", () => {
  it("starts a new list with Vouch's own header", () => {
    expect(addVouch(null, "NewBie")).toEqual({ result: "added", text: `${NEW_VOUCH_FILE_HEADER}newbie\n` });
    const text = (addVouch(null, "newbie") as { text: string }).text;
    expect(parseVouchFile(text).vouched.has("newbie")).toBe(true);
  });

  it("inserts the bare lowercased login in sorted position, changing nothing else", () => {
    const text = "# Our list\n\nalice\n-github:mallory spam\nzed\n";
    expect(addVouch(text, "Ned")).toEqual({ result: "added", text: "# Our list\n\nalice\n-github:mallory spam\nned\nzed\n" });
    expect(addVouch(text, "aaron")).toEqual({ result: "added", text: "# Our list\n\naaron\nalice\n-github:mallory spam\nzed\n" });
    expect(addVouch(text, "zz")).toEqual({ result: "added", text: "# Our list\n\nalice\n-github:mallory spam\nzed\nzz\n" });
  });

  it("appends after the last entry when the list is not sorted, keeping line endings", () => {
    expect(addVouch("github:zed\r\nalice\r\n# trailing note\r\n", "bob")).toEqual({
      result: "added",
      text: "github:zed\r\nalice\r\nbob\r\n# trailing note\r\n",
    });
    expect(addVouch("# only comments", "bob")).toEqual({ result: "added", text: "# only comments\nbob\n" });
  });

  it("leaves already vouched and denounced logins alone", () => {
    expect(addVouch("github:NewBie\n", "newbie")).toEqual({ result: "already-vouched" });
    expect(addVouch("newbie\n-newbie spam\n", "NEWBIE")).toEqual({ result: "denounced" });
    // Another platform's entry is not this GitHub account.
    expect(addVouch("gitlab:newbie\n", "newbie")).toMatchObject({ result: "added" });
  });

  it("refuses anything that is not a GitHub username", () => {
    for (const bad of ["", "-x", "a b", "a/../b", "x".repeat(40), "bot[bot]", "a\nb"]) {
      expect(() => addVouch("", bad)).toThrow(/not a GitHub username/);
    }
  });
});

describe("durations", () => {
  it("parses units and subtracts by the calendar", () => {
    expect(parseDuration("24mo")).toEqual({ amount: 24, unit: "mo" });
    expect(parseDuration("2 y")).toEqual({ amount: 2, unit: "y" });
    expect(parseDuration("0d")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    const at = new Date("2026-03-31T12:00:00Z");
    expect(subtractDuration(at, { amount: 1, unit: "y" }).toISOString()).toBe("2025-03-31T12:00:00.000Z");
    expect(subtractDuration(at, { amount: 2, unit: "w" }).toISOString()).toBe("2026-03-17T12:00:00.000Z");
  });
});

describe("parseConfig", () => {
  it("parses every rule kind with defaults", () => {
    const config = parseConfig(`
own_list: .github/VOUCHED.td
admit:
  - list: cloudflare/workers-sdk
  - list: hyprwm/.github:vouch/VOUCHED.td
  - merged: { repo: rust-lang/rust, min: 3, within: 2y }
  - merged: { repo: self }
exempt_paths: ["docs/**"]
on_unknown: close
`);
    expect(config.ownList).toEqual({ path: ".github/VOUCHED.td" });
    expect(config.admit.map(describeRule)).toEqual([
      "vouched in cloudflare/workers-sdk",
      "vouched in hyprwm/.github:vouch/VOUCHED.td",
      "≥3 merged PRs in rust-lang/rust within 2 years",
      "≥1 merged PR in this repo within 24 months",
    ]);
    expect(config.exemptPaths).toEqual(["docs/**"]);
    expect(config.onUnknown).toBe("close");
  });

  it("defaults to the auto-detected own list and no rules", () => {
    expect(parseConfig("")).toEqual({
      ownList: { path: null },
      admit: [],
      minAccountAge: null,
      exemptPaths: [],
      onUnknown: "label",
      onDenounced: "close",
      comment: "unknown",
      messageFile: null,
      labels: DEFAULT_LABELS,
    });
    expect(parseConfig("own_list: none").ownList).toBeNull();
  });

  it("parses the rules about the author, and the account age floor", () => {
    const config = parseConfig("min_account_age: 30d\nadmit:\n  - merged: { repo: any, min: 2, within: 24mo }\n  - org_member: ' rust-lang '\n");
    expect(config.minAccountAge).toEqual({ amount: 30, unit: "d" });
    expect(config.admit).toEqual([
      { kind: "merged", repo: "any", min: 2, within: { amount: 24, unit: "mo" } },
      { kind: "org_member", org: "rust-lang" },
    ]);
    expect(config.admit.map(describeRule)).toEqual(["≥2 merged PRs in others' public repos within 24 months", "public member of rust-lang"]);
    expect(parseConfig("min_account_age: null").minAccountAge).toBeNull();
    const problems = (text: string) => {
      try {
        parseConfig(text);
        return [];
      } catch (error) {
        return (error as ConfigError).problems;
      }
    };
    expect(problems("min_account_age: 30\n")).toEqual(["min_account_age must look like 30d, 8w, 6mo or 1y"]);
    expect(problems("min_account_age: 3m\n")).toEqual(['min_account_age must look like 30d, 8w, 6mo or 1y (did you mean "3mo"?)']);
    expect(problems("admit:\n  - org_member: rust-lang/rust\n  - org_member: https://github.com/tokio-rs\n  - org_member: { org: x }\n  - org_membr: x\n")).toEqual([
      "admit[0].org_member must be an organisation's login, such as rust-lang",
      'admit[1].org_member must be an organisation\'s login, such as rust-lang (did you mean "tokio-rs"?)',
      "admit[2].org_member must be an organisation's login, such as rust-lang",
      'admit[3] has unknown rule "org_membr" (did you mean "org_member"?)',
    ]);
  });

  it("reports every problem at once", () => {
    try {
      parseConfig(`
colour: blue
admit:
  - merged: { repo: nope, min: 0, within: forever }
  - vouched: x/y
on_unknown: delete
`);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([
        'unknown key "colour"',
        'admit[0].merged.repo must be "self", "any" or "owner/repo"',
        "admit[0].merged.min must be a whole number of at least 1",
        "admit[0].merged.within must look like 90d, 12w, 24mo or 2y",
        'admit[1] has unknown rule "vouched" (expected "list", "merged" or "org_member")',
        'on_unknown must be "label" or "close"',
      ]);
    }
  });

  it("parses the Action's settings", () => {
    const config = parseConfig(`
on_denounced: label
comment: never
message_file: .github/trust-message.md
labels: { unknown: "needs vouch", admitted: "" }
`);
    expect(config).toMatchObject({ onDenounced: "label", comment: "never", messageFile: ".github/trust-message.md" });
    expect(config.labels).toEqual({ ...DEFAULT_LABELS, unknown: "needs vouch", admitted: "" });
    expect(() => parseConfig("labels: { colour: x }")).toThrow('labels: unknown key "colour"');
  });

  it("parses list references", () => {
    expect(parseListRef("a/b")).toEqual({ repo: "a/b", path: null });
    expect(parseListRef("a/b:/x/VOUCHED.td")).toEqual({ repo: "a/b", path: "x/VOUCHED.td" });
    expect(parseListRef("a/b:")).toBeNull();
    expect(parseListRef("just-a-name")).toBeNull();
  });
});

describe("evaluate", () => {
  const at = new Date("2026-06-01T00:00:00Z");
  const sources = (overrides: Partial<TrustSources> = {}): TrustSources => ({
    ownList: () => "unknown",
    listVouches: () => false,
    mergedCount: () => 0,
    mergedElsewhereCount: () => 0,
    isPublicOrgMember: () => false,
    accountCreatedAt: () => null,
    ...overrides,
  });
  const config = parseConfig(`
admit:
  - list: other/project
  - merged: { repo: self, min: 2, within: 12mo }
exempt_paths: ["docs/**"]
`);
  const input = { config, repo: "me/repo", login: "Alice", at, changedPaths: ["src/a.ts"] };

  it("blocks denounced users before anything else, even on exempt paths", async () => {
    const d = await evaluate({ ...input, changedPaths: ["docs/x.md"] }, sources({ ownList: () => "denounced", listVouches: () => true }));
    expect(d.status).toBe("denounced");
  });

  it("checks the own list, then imported lists, then merge history", async () => {
    expect(await evaluate(input, sources({ ownList: () => "vouched" }))).toMatchObject({ status: "admitted", rule: "own list" });
    expect(await evaluate(input, sources({ listVouches: () => true }))).toMatchObject({ rule: "vouched in other/project" });
  });

  it("counts merges in this repo within the window before the PR", async () => {
    const calls: unknown[] = [];
    const d = await evaluate(
      input,
      sources({
        mergedCount: (repo, login, from, to, min) => {
          calls.push({ repo, login, from: from.toISOString(), to: to.toISOString(), min });
          return 2;
        },
      }),
    );
    expect(d).toMatchObject({ status: "admitted", reason: "2 merged PRs in me/repo" });
    expect(calls).toEqual([{ repo: "me/repo", login: "alice", from: "2025-06-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z", min: 2 }]);
    expect((await evaluate(input, sources({ mergedCount: () => 1 }))).status).toBe("unknown");
  });

  it("counts merges outside the author's own repositories and organisation membership", async () => {
    const rules = parseConfig("own_list: none\nadmit:\n  - merged: { repo: any, min: 3, within: 6mo }\n  - org_member: Rust-Lang\n");
    const calls: unknown[] = [];
    const d = await evaluate(
      { ...input, config: rules },
      sources({
        mergedElsewhereCount: (login, from, to, min) => {
          calls.push({ login, from: from.toISOString(), to: to.toISOString(), min });
          return 3;
        },
      }),
    );
    expect(d).toMatchObject({ status: "admitted", rule: "≥3 merged PRs in others' public repos within 6 months", reason: "3 merged PRs in others' public repositories" });
    expect(calls).toEqual([{ login: "alice", from: "2025-12-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z", min: 3 }]);
    const orgs: string[] = [];
    const member = await evaluate(
      { ...input, config: rules },
      sources({ mergedElsewhereCount: () => 2, isPublicOrgMember: (org, login) => (orgs.push(`${org}/${login}`), true) }),
    );
    expect(member).toMatchObject({ status: "admitted", rule: "public member of Rust-Lang", reason: "public member of Rust-Lang" });
    expect(orgs).toEqual(["Rust-Lang/alice"]);
  });

  describe("min_account_age", () => {
    const floor = parseConfig("min_account_age: 30d\nadmit:\n  - list: other/project\n  - org_member: org\nexempt_paths: [\"docs/**\"]\n");
    const daysBefore = (days: number) => new Date(at.getTime() - days * 86_400_000);

    it("holds back accounts younger than the floor at the time of the PR, naming the rule", async () => {
      let lookups = 0;
      const young = sources({ listVouches: () => true, isPublicOrgMember: () => true, accountCreatedAt: () => (lookups++, daysBefore(29)) });
      const d = await evaluate({ ...input, config: floor }, young);
      expect(d).toEqual({
        status: "unknown",
        reason: "the account is 29 days old, and rules other than this project's own list need an account at least 30 days old",
        heldBack: { rule: "vouched in other/project", accountCreatedAt: daysBefore(29).toISOString() },
      });
      expect(lookups).toBe(1);
      // Exactly 30 days old passes.
      expect((await evaluate({ ...input, config: floor }, sources({ listVouches: () => true, accountCreatedAt: () => daysBefore(30) }))).status).toBe("admitted");
    });

    it("never applies to the own list or denouncements, and leaves exempt paths alone", async () => {
      const young = { accountCreatedAt: () => daysBefore(1), listVouches: () => true };
      expect(await evaluate({ ...input, config: floor }, sources({ ...young, ownList: () => "vouched" }))).toMatchObject({ status: "admitted", rule: "own list" });
      expect((await evaluate({ ...input, config: floor }, sources({ ...young, ownList: () => "denounced" }))).status).toBe("denounced");
      expect((await evaluate({ ...input, config: floor, changedPaths: ["docs/a.md"] }, sources(young))).status).toBe("exempt");
    });

    it("treats an unknown creation date as too new, and is off by default", async () => {
      const d = await evaluate({ ...input, config: floor }, sources({ listVouches: () => true, accountCreatedAt: () => null }));
      expect(d).toMatchObject({ status: "unknown", heldBack: { accountCreatedAt: null } });
      const noFloor = sources({ listVouches: () => true, accountCreatedAt: () => { throw new Error("must not be asked"); } });
      expect((await evaluate(input, noFloor)).status).toBe("admitted");
    });
  });

  it("exempts PRs that only touch exempt paths, and only when the file list is known", async () => {
    expect((await evaluate({ ...input, changedPaths: ["docs/a.md", "docs/b/.c.md"] }, sources())).status).toBe("exempt");
    expect((await evaluate({ ...input, changedPaths: ["docs/a.md", "src/x.ts"] }, sources())).status).toBe("unknown");
    expect((await evaluate({ ...input, changedPaths: null }, sources())).status).toBe("unknown");
    expect((await evaluate({ ...input, changedPaths: [] }, sources())).status).toBe("unknown");
  });
});

describe("addVouch style", () => {
  it("keeps the github: prefix when every entry has it", async () => {
    const { addVouch } = await import("../src/engine/vouchfile.ts");
    expect(addVouch("# list\ngithub:zed\n", "Alice")).toEqual({ result: "added", text: "# list\ngithub:alice\ngithub:zed\n" });
    expect(addVouch("github:zed\nbob\n", "alice")).toMatchObject({ result: "added", text: "github:zed\nbob\nalice\n" });
  });

  it("names the exact line it adds", async () => {
    const { vouchEntry } = await import("../src/engine/vouchfile.ts");
    expect(vouchEntry(null, "NewBie")).toBe("newbie");
    expect(vouchEntry("# list\ngithub:zed\n-github:bad spam\n", "NewBie")).toBe("github:newbie");
    expect(vouchEntry("github:zed\nbob\n", "NewBie")).toBe("newbie");
    expect(vouchEntry("# only comments\n", "NewBie")).toBe("newbie");
  });
});

describe("action.yml", () => {
  it("keeps the description short enough for the GitHub Marketplace", async () => {
    const fs = await import("node:fs");
    const line = fs.readFileSync("action.yml", "utf8").split("\n").find((l) => l.startsWith("description: "))!;
    expect(line.slice("description: ".length).length).toBeLessThan(125);
  });
});
