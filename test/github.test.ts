import { describe, expect, it } from "vitest";
import { createClient, RetriesExhaustedError, type GraphQLClient } from "../src/github/client.ts";
import { countAuthorMerges, countMergedElsewhere, fetchAccountCreation, fetchPullRequests, searchAll } from "../src/github/queries.ts";

describe("searchAll", () => {
  it("splits ranges that exceed the 1000-result cap and pages through the rest", async () => {
    // 1500 fake items spread over a 10-day window, one every ~9.6 minutes.
    const start = Date.parse("2026-01-01T00:00:00Z");
    const items = Array.from({ length: 1500 }, (_, i) => ({ number: i, at: start + i * 576_000 }));
    const queries: string[] = [];

    const gh: GraphQLClient = {
      stats: { requests: 0, cached: 0 },
      async graphql<T>(_query: string, variables: Record<string, unknown> = {}) {
        const q = variables.q as string;
        queries.push(q);
        const [, from, to] = /created:(\S+)\.\.(\S+)/.exec(q)!;
        const inRange = items.filter((it) => it.at >= Date.parse(from!) && it.at <= Date.parse(to!));
        const offset = Number(variables.after ?? 0);
        const first = variables.first as number;
        const page = inRange.slice(offset, offset + first);
        return {
          search: {
            issueCount: inRange.length,
            pageInfo: { hasNextPage: offset + first < inRange.length, endCursor: String(offset + first) },
            nodes: page,
          },
        } as T;
      },
    };

    const result = await searchAll<{ number: number }>(gh, {
      base: "repo:a/b is:pr",
      field: "created",
      from: new Date(start),
      to: new Date(start + 10 * 86_400_000),
      fragment: "number",
      pageSize: 100,
    });

    expect(new Set(result.map((r) => r.number)).size).toBe(1500);
    expect(result.length).toBe(1500);
    expect(queries[0]).toBe("repo:a/b is:pr created:2026-01-01T00:00:00Z..2026-01-11T00:00:00Z");
  });
});

describe("countAuthorMerges", () => {
  const from = new Date("2026-01-01T00:00:00Z");
  const to = new Date("2026-07-01T00:00:00Z");
  const fake = (user: unknown) => {
    const requests: unknown[] = [];
    const gh: GraphQLClient = {
      stats: { requests: 0, cached: 0 },
      async graphql<T>(_query: string, variables: Record<string, unknown> = {}) {
        requests.push(variables);
        return { user } as T;
      },
    };
    return { gh, requests };
  };
  const pr = (number: number, nameWithOwner: string, mergedAt: string, updatedAt = mergedAt) => ({
    number,
    mergedAt,
    updatedAt,
    repository: { nameWithOwner },
  });

  it("counts merges into the repo in [from, to) and treats a missing user as unanswerable", async () => {
    const { gh } = fake({
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          pr(1, "a/b", "2026-07-01T00:00:00Z"), // at `to`: excluded
          pr(2, "a/b", "2026-03-01T00:00:00Z"),
          pr(3, "c/d", "2026-02-01T00:00:00Z"),
          pr(4, "A/B", "2025-12-31T00:00:00Z", "2026-02-01T00:00:00Z"), // merged before `from`
          pr(5, "a/b", "2026-01-01T00:00:00Z"),
        ],
      },
    });
    const options = { repo: "a/b", login: "x", from, to, min: 5, maxPages: 5 };
    expect(await countAuthorMerges(gh, options)).toEqual({ count: 2, complete: true });
    expect(await countAuthorMerges(fake(null).gh, options)).toBeNull();
  });
});

describe("fetchPullRequests", () => {
  it("walks PRs newest first, keeps the window and stops once past its start", async () => {
    const node = (number: number, createdAt: string) => ({
      number,
      createdAt,
      mergedAt: null,
      closedAt: null,
      state: "OPEN",
      authorAssociation: "NONE",
      changedFiles: 1,
      author: { login: `u${number}`, __typename: "User" },
      timelineItems: { nodes: [] },
    });
    const pages = [
      [node(5, "2026-12-01T00:00:00Z"), node(4, "2026-06-01T00:00:00Z")],
      [node(3, "2026-03-01T00:00:00Z"), node(2, "2025-12-01T00:00:00Z")],
      [node(1, "2025-01-01T00:00:00Z")],
    ];
    let calls = 0;
    const gh: GraphQLClient = {
      stats: { requests: 0, cached: 0 },
      async graphql<T>(_q: string, variables: Record<string, unknown> = {}) {
        const index = Number(variables.after ?? 0);
        calls++;
        return {
          repository: {
            pullRequests: {
              totalCount: 5,
              pageInfo: { hasNextPage: index < pages.length - 1, endCursor: String(index + 1) },
              nodes: pages[index],
            },
          },
        } as T;
      },
    };
    const prs = await fetchPullRequests(gh, "a/b", new Date("2026-01-01T00:00:00Z"), new Date("2026-11-27T00:00:00Z"), {
      withFiles: false,
    });
    expect(prs.map((p) => p.number)).toEqual([3, 4]);
    expect(calls).toBe(2);
  });
});

describe("searchAll page size", () => {
  it("halves the page size when GitHub keeps timing out, then carries on", async () => {
    const sizes: number[] = [];
    const progress: string[] = [];
    const gh: GraphQLClient = {
      stats: { requests: 0, cached: 0 },
      async graphql<T>(_q: string, variables: Record<string, unknown> = {}) {
        const first = variables.first as number;
        sizes.push(first);
        if (first > 20) throw new RetriesExhaustedError("timed out");
        return { search: { issueCount: 3, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ n: 1 }, { n: 2 }, { n: 3 }] } } as T;
      },
    };
    const result = await searchAll(gh, {
      base: "repo:a/b is:pr",
      field: "created",
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-02T00:00:00Z"),
      fragment: "n",
      pageSize: 80,
      onProgress: (m) => progress.push(m),
    });
    expect(result).toHaveLength(3);
    expect(sizes).toEqual([80, 40, 20]);
    expect(progress[0]).toContain("40 results per page");
  });
});

describe("createClient", () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  it("waits and retries on secondary rate limits and server errors", async () => {
    const responses = [
      json(403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "3" }),
      json(502, { message: "Bad gateway" }),
      json(200, { data: { ok: true } }),
    ];
    const waits: number[] = [];
    const gh = createClient({
      token: "t",
      fetchImpl: async () => responses.shift()!,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await expect(gh.graphql("{ ok }")).resolves.toEqual({ ok: true });
    expect(waits[0]).toBe(3000);
    expect(waits).toHaveLength(2);
    expect(gh.stats.requests).toBe(3);
  });

  it("fails fast on permission errors and GraphQL errors", async () => {
    const forbidden = createClient({ token: "t", fetchImpl: async () => json(403, { message: "Resource not accessible" }) });
    await expect(forbidden.graphql("{ x }")).rejects.toThrow("GitHub API 403: Resource not accessible");

    const notFound = createClient({
      token: "t",
      fetchImpl: async () => json(200, { errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }),
    });
    await expect(notFound.graphql("{ x }")).rejects.toThrow("Could not resolve to a Repository");
  });

  it("serves repeated queries from the cache", async () => {
    const store = new Map<string, unknown>();
    let calls = 0;
    const gh = createClient({
      token: "t",
      cache: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
      fetchImpl: async () => {
        calls++;
        return json(200, { data: { n: 1 } });
      },
    });
    await gh.graphql("{ n }");
    await gh.graphql("{ n }");
    expect(calls).toBe(1);
    expect(gh.stats.cached).toBe(1);
  });
});

describe("countMergedElsewhere", () => {
  const from = new Date("2026-01-01T00:00:00Z");
  const to = new Date("2026-07-01T00:00:00Z");
  const merge = (mergedAt: string, mergedBy: string | null, owner: string) => ({
    mergedAt,
    mergedBy: mergedBy ? { login: mergedBy } : null,
    repository: { owner: { login: owner } },
  });
  const fake = (nodes: unknown[]) => {
    const queries: string[] = [];
    const gh: GraphQLClient = {
      stats: { requests: 0, cached: 0 },
      async graphql<T>(_query: string, variables: Record<string, unknown> = {}) {
        queries.push(variables.q as string);
        const offset = Number(variables.after ?? 0);
        const page = nodes.slice(offset, offset + 100);
        return { search: { issueCount: nodes.length, pageInfo: { hasNextPage: offset + 100 < nodes.length, endCursor: String(offset + 100) }, nodes: page } } as T;
      },
    };
    return { gh, queries };
  };

  it("searches once, leaving out the author's own repositories and their own merges", async () => {
    const { gh, queries } = fake([
      merge("2026-03-01T00:00:00Z", "Alice", "alices-org"),
      merge("2026-03-02T00:00:00Z", "bob", "ALICE"),
      merge("2026-03-03T00:00:00Z", "bob", "big"),
      merge("2026-07-01T00:00:00Z", "bob", "big"), // the window's end is not in it
      merge("2026-03-04T00:00:00Z", null, "lib"),
    ]);
    expect(await countMergedElsewhere(gh, { login: "alice", from, to, min: 5, maxPages: 3 })).toEqual({ count: 2, complete: true, found: 5 });
    expect(queries).toEqual(["is:pr is:merged is:public author:alice -user:alice merged:2026-01-01T00:00:00Z..2026-07-01T00:00:00Z"]);
  });

  it("stops at min, and reports when the page cap leaves the answer open", async () => {
    const many = Array.from({ length: 250 }, () => merge("2026-03-03T00:00:00Z", "bob", "big"));
    const early = fake(many);
    expect(await countMergedElsewhere(early.gh, { login: "alice", from, to, min: 2, maxPages: 3 })).toEqual({ count: 2, complete: true, found: 250 });
    expect(early.queries).toHaveLength(1);
    const own = fake(Array.from({ length: 250 }, () => merge("2026-03-03T00:00:00Z", "alice", "alices-org")));
    expect(await countMergedElsewhere(own.gh, { login: "alice", from, to, min: 1, maxPages: 2 })).toEqual({ count: 0, complete: false, found: 250 });
    // 250 results can never make 300: one page is enough to know.
    const short = fake(many);
    expect(await countMergedElsewhere(short.gh, { login: "alice", from, to, min: 300, maxPages: 3 })).toEqual({ count: 100, complete: true, found: 250 });
    expect(short.queries).toHaveLength(1);
  });
});

describe("fetchAccountCreation", () => {
  it("reads 50 logins per request and skips ones that are not users", async () => {
    const queries: string[] = [];
    const gh: GraphQLClient = {
      stats: { requests: 0, cached: 0 },
      async graphql<T>(query: string) {
        const logins = [...query.matchAll(/(u\d+): user\(login: "([^"]+)"\)/g)];
        queries.push(logins.map((l) => l[2]).join(","));
        if (logins.some(([, , login]) => login === "an-org")) {
          throw new Error("GitHub GraphQL error: Could not resolve to a User with the login of 'an-org'.");
        }
        return Object.fromEntries(logins.map(([, alias, login]) => [alias, { createdAt: `2020-01-01T00:00:00Z#${login}` }])) as T;
      },
    };
    const logins = Array.from({ length: 51 }, (_, i) => `user${i}`);
    const created = await fetchAccountCreation(gh, logins);
    expect(created.size).toBe(51);
    expect(queries).toHaveLength(2);

    queries.length = 0;
    const mixed = await fetchAccountCreation(gh, ["Alice", "an-org"]);
    expect([...mixed.keys()]).toEqual(["alice"]);
    expect(queries).toEqual(["Alice,an-org", "Alice", "an-org"]);
  });
});
