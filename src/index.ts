/**
 * GoBouncer - Node.js client for the GoBouncer rate limiting service.
 *
 * GoBouncer itself is a Go service backed by Redis. This package is a thin,
 * dependency-free client that talks to it over HTTP and exposes an
 * Express-style middleware so you can drop rate limiting onto any route
 * in a couple of lines.
 */

import {
  Algorithm,
  CheckResult,
  GoBouncerOptions,
  KeyFunc,
  LimitOptions,
  MinimalRequest,
  MinimalResponse,
  PolicyOptions,
} from "./types";
import { namespacedPolicyKey, normalizePolicyAlgorithm } from "./policy-utils";

// Default key function

/** Default key function - limits by client IP address. */
export const ipKey: KeyFunc = (req) => `ip:${req.ip ?? "unknown"}`;

/** Build a key function that reads a specific header (falls back to IP if missing). */
export function headerKey(headerName: string): KeyFunc {
  const lower = headerName.toLowerCase();
  return (req) => {
    const value = req.headers[lower];
    const resolved = Array.isArray(value) ? value[0] : value;
    return resolved ? `${lower}:${resolved}` : ipKey(req);
  };
}

// Client

export class GoBouncerClient {
  public readonly url: string;
  public readonly timeoutMs: number;
  public readonly failOpen: boolean;
  public readonly apiKey?: string;
  public readonly onError?: (err: Error) => void;
  public readonly policies: GoBouncerOptions["policies"];

  constructor(opts: GoBouncerOptions) {
    this.url = opts.url.replace(/\/+$/, ""); // strip trailing slash
    this.timeoutMs = opts.timeoutMs ?? 150;
    this.failOpen = opts.failOpen ?? true;
    this.apiKey = opts.apiKey;
    this.onError = opts.onError;
    this.policies = opts.policies ?? {};
  }

  /**
   * Ask GoBouncer whether this key should be allowed right now.
   * Never throws - on any failure it resolves according to `failOpen`.
   */
  async check(
    key: string,
    max: number,
    windowMs: number,
    algorithm: Algorithm = "sliding_window"
  ): Promise<CheckResult> {
    return this.sendCheck({
      key,
      limit: max,
      window_ms: windowMs,
      algorithm,
    });
  }

  /**
   * Ask GoBouncer to check a key against a named server-side policy.
   */
  async checkPolicy(key: string, policy: string): Promise<CheckResult> {
    return this.sendCheck({
      key,
      policy,
    });
  }

  private async sendCheck(body: Record<string, unknown>): Promise<CheckResult> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiKey) headers["X-GoBouncer-Key"] = this.apiKey;

      const res = await fetch(`${this.url}/check`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        const err = new Error(`GoBouncer returned status ${res.status}`);
        if (this.onError) {
          try { this.onError(err); } catch {
            // Ignore errors in the error callback
          }
        } 
        return this.fallback();
      }

      const result = (await res.json()) as CheckResult;
      const limitHeader = res.headers?.get("X-RateLimit-Limit");
      const policyHeader = res.headers?.get("X-RateLimit-Policy");

      if (limitHeader !== null && limitHeader !== undefined) {
        const parsed = Number(limitHeader);
        if (Number.isFinite(parsed)) result.limit = parsed;
      }
      if (policyHeader) result.policy = policyHeader;

      return result;
    } catch (err) {
      if (this.onError) {
        try {
          this.onError(err instanceof Error ? err : new Error(String(err)));
        } catch {
          // Ignore errors in the error callback
        }
      }
      // network error, timeout, GoBouncer down, etc.
      return this.fallback();
    }
  }

  /**
   * Check connection to the GoBouncer service.
   * Sends a ping/health request and returns true if online.
   */
  async ping(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers["X-GoBouncer-Key"] = this.apiKey;

      const res = await fetch(`${this.url}/health`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      }).catch(async () => {
        return fetch(`${this.url}/`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      });

      return res.ok;
    } catch {
      return false;
    }
  }

  private fallback(): CheckResult {
    return this.failOpen
      ? { allowed: true, remaining: -1 }
      : { allowed: false, remaining: 0, retry_after: 0 };
  }

  /**
   * Express-style middleware factory. Use once per route (or globally)
   * with whatever limit, window, and key strategy that route needs.
   *
   * @example
   * app.use(client.limit({ max: 100, windowMs: 60_000 }))
   * app.post('/login', client.limit({ max: 5, windowMs: 60_000 }), loginHandler)
   */
  limit<Req extends MinimalRequest = MinimalRequest>(
    opts: LimitOptions<Req>
  ) {
    const keyFn = opts.key ?? (ipKey as KeyFunc<Req>);
    const algorithm = opts.algorithm ?? "sliding_window";

    return async (
      req: Req,
      res: MinimalResponse,
      next: (err?: unknown) => void
    ): Promise<void> => {
      const key = keyFn(req);
      const result = await this.check(key, opts.max, opts.windowMs, algorithm);

      res.setHeader("X-RateLimit-Limit", opts.max);
      res.setHeader("X-RateLimit-Remaining", result.remaining);

      if (result.retry_after !== undefined) {
        const resetEpochSec = Math.ceil((Date.now() + result.retry_after) / 1000);
        res.setHeader("X-RateLimit-Reset", resetEpochSec);
      }

      if (!result.allowed) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil((result.retry_after ?? 0) / 1000)
        );
        res.setHeader("Retry-After", retryAfterSec);
        res.status(429).json({
          error: "too many requests",
          retry_after_ms: result.retry_after ?? 0,
        });
        return;
      }

      next();
    };
  }

  /**
   * Express-style middleware for named GoBouncer policies.
   *
   * @example
   * app.post('/login', client.policy({ name: 'login' }), loginHandler)
   */
  policy<Req extends MinimalRequest = MinimalRequest>(
    opts: PolicyOptions<Req>
  ) {
    const keyFn = opts.key ?? (ipKey as KeyFunc<Req>);

    return async (
      req: Req,
      res: MinimalResponse,
      next: (err?: unknown) => void
    ): Promise<void> => {
      const key = keyFn(req);
      const result = await this.checkPolicy(key, opts.name);

      res.setHeader("X-RateLimit-Policy", result.policy ?? opts.name);
      res.setHeader("X-RateLimit-Remaining", result.remaining);
      if (result.limit !== undefined) {
        res.setHeader("X-RateLimit-Limit", result.limit);
      }

      if (result.retry_after !== undefined) {
        const resetEpochSec = Math.ceil((Date.now() + result.retry_after) / 1000);
        res.setHeader("X-RateLimit-Reset", resetEpochSec);
      }

      if (!result.allowed) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil((result.retry_after ?? 0) / 1000)
        );

        res.setHeader("Retry-After", retryAfterSec);
        res.status(429).json({
          error: "too many requests",
          retry_after_ms: result.retry_after ?? 0,
        });
        return;
      }

      next();
    };
  }

  /**
   * Express-style middleware for an application policy name.
   * If the policy exists in `gobouncer({ policies })`, its local limit settings are used.
   * Otherwise the name is sent to GoBouncer as a server-side named policy.
   *
   * @example
   * app.get('/profile', client.use('profileRead'), handler)
   */
  use<Req extends MinimalRequest = MinimalRequest>(
    name: string,
    opts: Omit<PolicyOptions<Req>, "name"> = {}
  ) {
    const policy = this.policies?.[name];

    if (!policy) {
      return this.policy({ ...opts, name });
    }

    const algorithm = normalizePolicyAlgorithm(policy.algorithm);
    const keyFn = opts.key ?? (ipKey as KeyFunc<Req>);

    return this.limit({
      max: policy.limit,
      windowMs: policy.windowMs,
      algorithm,
      key: (req: Req) => namespacedPolicyKey(name, algorithm, keyFn(req)),
    });
  }
}

// Factory function - the main entry point most users will reach for

/**
 * Create a GoBouncer client.
 *
 * @example
 * import { gobouncer } from 'gobouncer'
 *
 * const limiter = gobouncer({ url: 'http://localhost:8080' })
 *
 * app.use(limiter.limit({ max: 100, windowMs: 60_000 }))
 */
export function gobouncer(opts: GoBouncerOptions): GoBouncerClient {
  return new GoBouncerClient(opts);
}
