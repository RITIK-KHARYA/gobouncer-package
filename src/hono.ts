/**
 * GoBouncer — Hono middleware adapter.
 *
 * This module provides a Hono-native middleware factory that wraps the
 * framework-agnostic GoBouncerClient.check() method. Import from
 * 'gobouncer/hono' to use it.
 *
 * @example
 * import { gobouncer } from 'gobouncer'
 * import { honoLimit } from 'gobouncer/hono'
 *
 * const limiter = gobouncer({ url: 'http://localhost:8080' })
 *
 * app.use(honoLimit(limiter, { max: 100, windowMs: 60_000 }))
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import { GoBouncerClient } from './index';
import type { HonoKeyFunc, HonoLimitOptions } from './types-hono';

/** Default key — extract client IP from standard proxy headers. */
export const honoIpKey: HonoKeyFunc = (c) => {
  const forwarded = c.req.header('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
  return `ip:${ip}`;
};

/** Build a Hono-compatible key function from a header name. */
export function honoHeaderKey(headerName: string): HonoKeyFunc {
  return (c) => {
    const value = c.req.header(headerName);
    return value ? `${headerName.toLowerCase()}:${value}` : honoIpKey(c);
  };
}

// ── Middleware factory ─────────────────────────────────────────────

/**
 * Create a Hono middleware from an existing GoBouncerClient.
 *
 * @example
 * import { gobouncer } from 'gobouncer'
 * import { honoLimit } from 'gobouncer/hono'
 *
 * const limiter = gobouncer({ url: 'http://localhost:8080' })
 *
 * app.use('/api/*', honoLimit(limiter, { max: 100, windowMs: 60_000 }))
 *
 * app.post('/login', honoLimit(limiter, {
 *   max: 5,
 *   windowMs: 60_000,
 *   key: (c) => `user:${c.req.header('x-user-id') ?? 'anon'}`,
 * }), loginHandler)
 */
export function honoLimit(
  client: GoBouncerClient,
  opts: HonoLimitOptions
): MiddlewareHandler {
  const keyFn = opts.key ?? honoIpKey;
  const algorithm = opts.algorithm ?? 'sliding_window';

  return async (c: Context, next: Next) => {
    const key = keyFn(c);
    const result = await client.check(key, opts.max, opts.windowMs, algorithm);

    c.header('X-RateLimit-Limit', String(opts.max));
    c.header('X-RateLimit-Remaining', String(result.remaining));

    if (result.retry_after !== undefined) {
      const resetEpochSec = Math.ceil((Date.now() + result.retry_after) / 1000);
      c.header('X-RateLimit-Reset', String(resetEpochSec));
    }

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.retry_after ?? 0) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        { error: 'too many requests', retry_after_ms: result.retry_after ?? 0 },
        429
      );
    }

    await next();
  };
}
