/**
 * GoBouncer — Node.js client for the GoBouncer rate limiting service.
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
} from "./types";

// ── Default key function ──────────────────────────────────────────

/** Default key function — limits by client IP address. */
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

// ── Client ─────────────────────────────────────────────────────────

export class GoBouncerClient {
  public readonly url: string;
  public readonly timeoutMs: number;
  public readonly failOpen: boolean;
  public readonly apiKey?: string;
  public readonly onError?: (err: Error) => void;

  constructor(opts: GoBouncerOptions) {
    this.url = opts.url.replace(/\/+$/, ""); // strip trailing slash
    this.timeoutMs = opts.timeoutMs ?? 150;
    this.failOpen = opts.failOpen ?? true;
    this.apiKey = opts.apiKey;
    this.onError = opts.onError;
  }

  /**
   * Ask GoBouncer whether this key should be allowed right now.
   * Never throws — on any failure it resolves according to `failOpen`.
   */
  async check(
    key: string,
    max: number,
    windowMs: number,
    algorithm: Algorithm = "sliding_window"
  ): Promise<CheckResult> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiKey) headers["X-GoBouncer-Key"] = this.apiKey;

      const res = await fetch(`${this.url}/check`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          key,
          limit: max,
          window_ms: windowMs,
          algorithm,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        const err = new Error(`GoBouncer returned status ${res.status}`);
        if (this.onError) {
          try { this.onError(err); } catch {}
        }
        return this.fallback();
      }

      return (await res.json()) as CheckResult;
    } catch (err) {
      if (this.onError) {
        try {
          this.onError(err instanceof Error ? err : new Error(String(err)));
        } catch {}
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
}

// ── Factory function — the main entry point most users will reach for ──

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
