import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_LABELS, describeRule, parseConfig, parseListRef } from "../src/engine/config.ts";
import { parseDuration, subtractDuration } from "../src/engine/duration.ts";
import { evaluate, type TrustSources } from "../src/engine/rules.ts";
import { parseVouchFile } from "../src/engine/vouchfile.ts";

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
      exemptPaths: [],
      onUnknown: "label",
      onDenounced: "close",
      comment: "unknown",
      messageFile: null,
      labels: DEFAULT_LABELS,
    });
    expect(parseConfig("own_list: none").ownList).toBeNull();
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
        'admit[0].merged.repo must be "self" or "owner/repo"',
        "admit[0].merged.min must be a whole number of at least 1",
        "admit[0].merged.within must look like 90d, 12w, 24mo or 2y",
        'admit[1] has unknown rule "vouched" (expected "list" or "merged")',
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
        mergedCount: (repo, login, from, to) => {
          calls.push({ repo, login, from: from.toISOString(), to: to.toISOString() });
          return 2;
        },
      }),
    );
    expect(d).toMatchObject({ status: "admitted", reason: "2 merged PRs in me/repo" });
    expect(calls).toEqual([{ repo: "me/repo", login: "alice", from: "2025-06-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" }]);
    expect((await evaluate(input, sources({ mergedCount: () => 1 }))).status).toBe("unknown");
  });

  it("exempts PRs that only touch exempt paths, and only when the file list is known", async () => {
    expect((await evaluate({ ...input, changedPaths: ["docs/a.md", "docs/b/.c.md"] }, sources())).status).toBe("exempt");
    expect((await evaluate({ ...input, changedPaths: ["docs/a.md", "src/x.ts"] }, sources())).status).toBe("unknown");
    expect((await evaluate({ ...input, changedPaths: null }, sources())).status).toBe("unknown");
    expect((await evaluate({ ...input, changedPaths: [] }, sources())).status).toBe("unknown");
  });
});
