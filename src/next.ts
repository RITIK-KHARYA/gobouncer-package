import { GoBouncerClient } from './index';
import type { NextLimitOptions } from './types';

/** Default key function — limits by client IP address. */
export const nextIpKey = (req: Request): string => {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || (req as any).ip // support NextRequest.ip
    || 'unknown';
  return `ip:${ip}`;
};

/** Build a key function that reads a specific header (falls back to IP if missing). */
export function nextHeaderKey(headerName: string) {
  const lower = headerName.toLowerCase();
  return (req: Request): string => {
    const value = req.headers.get(lower);
    return value ? `${lower}:${value}` : nextIpKey(req);
  };
}

/**
 * Create a Next.js / Edge-compatible rate limiter from an existing GoBouncerClient.
 * Returns a Response object (429) if limit exceeded, or null if allowed.
 *
 * @example
 * import { gobouncer } from 'gobouncer'
 * import { nextLimit } from 'gobouncer/next'
 *
 * const limiter = gobouncer({ url: 'http://localhost:8080' })
 * const limit = nextLimit(limiter, { max: 100, windowMs: 60000 })
 *
 * export async function middleware(req: Request) {
 *   const blockedResponse = await limit(req)
 *   if (blockedResponse) return blockedResponse
 *   return NextResponse.next()
 * }
 */
export function nextLimit(
  client: GoBouncerClient,
  opts: NextLimitOptions
) {
  const keyFn = opts.key ?? nextIpKey;
  const algorithm = opts.algorithm ?? 'sliding_window';

  return async (req: Request): Promise<Response | null> => {
    const key = keyFn(req);
    const result = await client.check(key, opts.max, opts.windowMs, algorithm);

    if (!result.allowed) {
      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-RateLimit-Limit': String(opts.max),
        'X-RateLimit-Remaining': String(result.remaining),
      });

      if (result.retry_after !== undefined) {
        const resetEpochSec = Math.ceil((Date.now() + result.retry_after) / 1000);
        headers.set('X-RateLimit-Reset', String(resetEpochSec));
        const retryAfterSec = Math.max(1, Math.ceil(result.retry_after / 1000));
        headers.set('Retry-After', String(retryAfterSec));
      }

      return new Response(
        JSON.stringify({
          error: 'too many requests',
          retry_after_ms: result.retry_after ?? 0,
        }),
        { status: 429, headers }
      );
    }

    return null;
  };
}
