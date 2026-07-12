import type { Context } from 'elysia';
import { GoBouncerClient } from './index';
import type { Algorithm } from './types';

export interface ElysiaLimitOptions {
  /** Max requests allowed within the window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** How to derive the key for this route. Defaults to limiting by IP. */
  key?: (c: Context) => string;
  /** Which algorithm to use. Defaults to "sliding_window". */
  algorithm?: Algorithm;
}

/** Default key function — limits by client IP address. */
export const elysiaIpKey = (c: Context): string => {
  const forwarded = c.request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim()
    || c.request.headers.get('x-real-ip')
    || (c as any).ip
    || 'unknown';
  return `ip:${ip}`;
};

/** Build a key function that reads a specific header (falls back to IP if missing). */
export function elysiaHeaderKey(headerName: string) {
  const lower = headerName.toLowerCase();
  return (c: Context): string => {
    const value = c.request.headers.get(lower);
    return value ? `${lower}:${value}` : elysiaIpKey(c);
  };
}

/**
 * Create an Elysia rate-limiting beforeHandle hook from an existing GoBouncerClient.
 *
 * @example
 * import { Elysia } from 'elysia'
 * import { gobouncer } from 'gobouncer'
 * import { elysiaLimit } from 'gobouncer/elysia'
 *
 * const limiter = gobouncer({ url: 'http://localhost:8080' })
 *
 * new Elysia()
 *   .get('/api', () => 'hi', {
 *     beforeHandle: elysiaLimit(limiter, { max: 100, windowMs: 60000 })
 *   })
 *   .listen(3000)
 */
export function elysiaLimit(
  client: GoBouncerClient,
  opts: ElysiaLimitOptions
) {
  const keyFn = opts.key ?? elysiaIpKey;
  const algorithm = opts.algorithm ?? 'sliding_window';

  return async (c: Context) => {
    const key = keyFn(c);
    const result = await client.check(key, opts.max, opts.windowMs, algorithm);

    c.set.headers['X-RateLimit-Limit'] = String(opts.max);
    c.set.headers['X-RateLimit-Remaining'] = String(result.remaining);

    if (result.retry_after !== undefined) {
      const resetEpochSec = Math.ceil((Date.now() + result.retry_after) / 1000);
      c.set.headers['X-RateLimit-Reset'] = String(resetEpochSec);
    }

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.retry_after ?? 0) / 1000));
      c.set.headers['Retry-After'] = String(retryAfterSec);
      c.set.status = 429;
      return {
        error: 'too many requests',
        retry_after_ms: result.retry_after ?? 0,
      };
    }
  };
}
