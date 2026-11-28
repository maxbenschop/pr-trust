import { execFileSync } from "node:child_process";
import { NO_CACHE, type DiskCache } from "./cache.ts";

const DOTCOM_API = "https://api.github.com";
const DOTCOM = "https://github.com";
const MAX_ATTEMPTS = 8;

export type CallOptions = { attempts?: number };

export type RestResponse<T> = { status: number; data: T };

export type GraphQLClient = {
  graphql<T>(query: string, variables?: Record<string, unknown>, call?: CallOptions): Promise<T>;
  readonly stats: { requests: number; cached: number };
};

/** Where the API and the website of this GitHub live: github.com, GHE Cloud or GHE Server. */
export type Endpoints = {
  /** REST root, such as https://api.github.com or https://github.example.com/api/v3. */
  api: string;
  graphql: string;
  /** Website root, used for links in comments: https://github.com or https://github.example.com. */
  server: string;
  /** False on GitHub Enterprise Server and on GHE Cloud with data residency (ghe.com). */
  dotcom: boolean;
};

type Env = Record<string, string | undefined>;

function root(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubError(`${name} is not a URL: "${value}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new GitHubError(`${name} must start with https://, got "${value}"`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * GitHub Actions sets GITHUB_API_URL, GITHUB_GRAPHQL_URL and GITHUB_SERVER_URL on every runner,
 * so the Action follows the server it runs on. For the command line, GH_HOST (the GitHub CLI's
 * variable) is enough: `GH_HOST=github.example.com pr-trust check owner/repo#1`.
 */
export function resolveEndpoints(env: Env = process.env): Endpoints {
  let api = env.GITHUB_API_URL ? root(env.GITHUB_API_URL, "GITHUB_API_URL") : null;
  if (!api && env.GH_HOST && env.GH_HOST !== "github.com") {
    const host = env.GH_HOST.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    // GHE Cloud with data residency serves the API from a subdomain; GHE Server from a path.
    api = root(host.endsWith(".ghe.com") ? `https://api.${host}` : `https://${host}/api/v3`, "GH_HOST");
  }
  api ??= DOTCOM_API;

  const url = new URL(api);
  const onPath = /\/api\/v3$/.test(url.pathname);
  const graphql = env.GITHUB_GRAPHQL_URL
    ? root(env.GITHUB_GRAPHQL_URL, "GITHUB_GRAPHQL_URL")
    : onPath
      ? `${api.slice(0, -"/v3".length)}/graphql`
      : `${api}/graphql`;
  const server = env.GITHUB_SERVER_URL
    ? root(env.GITHUB_SERVER_URL, "GITHUB_SERVER_URL")
    : api === DOTCOM_API
      ? DOTCOM
      : onPath
        ? api.slice(0, -"/api/v3".length)
        : `${url.protocol}//${url.host.replace(/^api\./, "")}`;
  return { api, graphql, server, dotcom: api === DOTCOM_API };
}

export type GitHubClient = GraphQLClient & {
  /** Absent on test doubles, which stand in for github.com. */
  readonly endpoints?: Endpoints;
  /**
   * A REST call. Statuses in `allow` (such as 404) are returned instead of thrown.
   * REST responses are never cached.
   */
  rest<T = unknown>(method: string, path: string, body?: unknown, allow?: number[]): Promise<RestResponse<T>>;
};

export type ClientOptions = {
  token: string;
  /** Only GraphQL responses are cached. */
  cache?: DiskCache;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  /** Defaults to the environment's server (see resolveEndpoints). */
  endpoints?: Endpoints;
};

export class GitHubError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** Transient failures (timeouts, 5xx, unreadable responses) that outlasted the retries. */
export class RetriesExhaustedError extends GitHubError {}

/**
 * GITHUB_TOKEN, then GH_TOKEN, then the GitHub CLI's login. On another server than github.com,
 * GH_ENTERPRISE_TOKEN and GITHUB_ENTERPRISE_TOKEN come first and the CLI is asked for that
 * host's login, as the GitHub CLI itself does. The token is never printed.
 */
export function resolveToken(endpoints: Endpoints = resolveEndpoints(), env: Env = process.env): string {
  const enterprise = endpoints.dotcom ? undefined : env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN;
  const fromEnv = enterprise || env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  const host = new URL(endpoints.server).host;
  try {
    const token = execFileSync("gh", endpoints.dotcom ? ["auth", "token"] : ["auth", "token", "--hostname", host], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) return token;
  } catch {
    // fall through
  }
  throw new GitHubError(
    endpoints.dotcom
      ? "No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`."
      : `No token found for ${host}. Set GH_ENTERPRISE_TOKEN or run \`gh auth login --hostname ${host}\`.`,
  );
}

type Body = { data?: unknown; errors?: { type?: string; message: string }[]; message?: string } | null;

export function createClient(options: ClientOptions): GitHubClient {
  const cache = options.cache ?? NO_CACHE;
  const log = options.log ?? (() => {});
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stats = { requests: 0, cached: 0 };
  const endpoints = options.endpoints ?? resolveEndpoints();
  // Another server's answers must never be served from github.com's cache, or the reverse.
  const cachePrefix = endpoints.dotcom ? "" : `${endpoints.graphql}\n`;
  const headers = {
    authorization: `bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": options.userAgent ?? "pr-trust",
    "x-github-api-version": "2022-11-28",
  };

  /**
   * Sends a request, retrying network errors, 5xx, rate limits and unreadable bodies.
   * `isRetryable` lets GraphQL retry on errors reported inside a 200 response.
   */
  async function send(
    method: string,
    url: string,
    body: unknown,
    maxAttempts: number,
    isRetryable: (status: number, body: Body) => string | null = () => null,
  ): Promise<{ response: Response; body: Body }> {
    for (let attempt = 1; ; attempt++) {
      const retry = async (why: string, waitMs: number) => {
        if (attempt >= maxAttempts) throw new RetriesExhaustedError(`GitHub API failed after ${attempt} attempts: ${why}`);
        log(`${why}; retrying in ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
      };

      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        await retry(`network error (${(error as Error).message})`, backoff(attempt));
        continue;
      }
      stats.requests++;

      const text = await response.text().catch(() => null);
      let parsed: Body = null;
      let readable = text !== null;
      if (text) {
        try {
          parsed = JSON.parse(text) as Body;
        } catch {
          readable = false;
        }
      }
      const message = messageOf(parsed, response);

      if (response.status === 401) {
        throw new GitHubError("GitHub rejected the token (401). Check the token or `gh auth status`.", 401);
      }
      if (response.status === 403 || response.status === 429) {
        if (/rate limit|abuse/i.test(message) || response.headers.get("retry-after")) {
          await retry(`rate limited (${response.status})`, rateLimitWait(response));
          continue;
        }
      }
      if (response.status >= 500) {
        await retry(`GitHub API ${response.status}`, backoff(attempt));
        continue;
      }
      if (response.ok && !readable) {
        await retry("unreadable response from GitHub", backoff(attempt));
        continue;
      }
      const why = isRetryable(response.status, parsed);
      if (why) {
        await retry(why, why.includes("rate limit") ? rateLimitWait(response) : backoff(attempt));
        continue;
      }
      return { response, body: parsed };
    }
  }

  async function graphql<T>(query: string, variables: Record<string, unknown> = {}, call: CallOptions = {}): Promise<T> {
    const key = cachePrefix + JSON.stringify({ query, variables });
    const hit = cache.get(key);
    if (hit !== undefined) {
      stats.cached++;
      return hit as T;
    }

    const { response, body } = await send("POST", endpoints.graphql, { query, variables }, call.attempts ?? MAX_ATTEMPTS, (_s, b) => {
      if (b?.errors?.some((e) => e.type === "RATE_LIMITED")) return "GraphQL rate limit reached";
      if (b?.errors?.some((e) => /timeout|timed out|something went wrong/i.test(e.message))) return "GraphQL query timed out";
      return null;
    });
    if (!response.ok) throw new GitHubError(`GitHub API ${response.status}: ${messageOf(body, response)}`, response.status);
    if (body?.errors?.length) {
      throw new GitHubError(`GitHub GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    cache.set(key, body?.data);
    return body?.data as T;
  }

  async function rest<T>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<RestResponse<T>> {
    const { response, body: parsed } = await send(method, `${endpoints.api}${path}`, body, MAX_ATTEMPTS);
    if (!response.ok && !allow.includes(response.status)) {
      throw new GitHubError(`GitHub API ${method} ${path} returned ${response.status}: ${messageOf(parsed, response)}`, response.status);
    }
    return { status: response.status, data: parsed as T };
  }

  return { graphql, rest, stats, endpoints };
}

function messageOf(body: Body, response: Response): string {
  return body?.message ?? body?.errors?.map((e) => e.message).join("; ") ?? response.statusText;
}

function backoff(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

function rateLimitWait(response: Response): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter * 1000;
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.get("x-ratelimit-remaining") === "0" && reset > 0) {
    return Math.max(1000, reset * 1000 - Date.now() + 1000);
  }
  return 60_000;
}
