import { execFileSync } from "node:child_process";
import { NO_CACHE, type DiskCache } from "./cache.ts";

const API = "https://api.github.com";
const MAX_ATTEMPTS = 8;

export type CallOptions = { attempts?: number };

export type RestResponse<T> = { status: number; data: T };

export type GraphQLClient = {
  graphql<T>(query: string, variables?: Record<string, unknown>, call?: CallOptions): Promise<T>;
  readonly stats: { requests: number; cached: number };
};

export type GitHubClient = GraphQLClient & {
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

/** GITHUB_TOKEN, then GH_TOKEN, then the GitHub CLI's login. The token is never printed. */
export function resolveToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) return token;
  } catch {
    // fall through
  }
  throw new GitHubError("No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.");
}

type Body = { data?: unknown; errors?: { type?: string; message: string }[]; message?: string } | null;

export function createClient(options: ClientOptions): GitHubClient {
  const cache = options.cache ?? NO_CACHE;
  const log = options.log ?? (() => {});
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stats = { requests: 0, cached: 0 };
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
    const key = JSON.stringify({ query, variables });
    const hit = cache.get(key);
    if (hit !== undefined) {
      stats.cached++;
      return hit as T;
    }

    const { response, body } = await send("POST", `${API}/graphql`, { query, variables }, call.attempts ?? MAX_ATTEMPTS, (_s, b) => {
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
    const { response, body: parsed } = await send(method, `${API}${path}`, body, MAX_ATTEMPTS);
    if (!response.ok && !allow.includes(response.status)) {
      throw new GitHubError(`GitHub API ${method} ${path} returned ${response.status}: ${messageOf(parsed, response)}`, response.status);
    }
    return { status: response.status, data: parsed as T };
  }

  return { graphql, rest, stats };
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
