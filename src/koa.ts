import type { Context, Next } from 'koa';
import { GoBouncerClient } from './index';
import { namespacedPolicyKey, normalizePolicyAlgorithm } from './policy-utils';
import type { KoaLimitOptions } from './types';

/** Default key function - limits by client IP address. */
export const koaIpKey = (ctx: Context): string => {
  const ip = ctx.ip || 'unknown';
  return `ip:${ip}`;
};

/** Build a key function that reads a specific header (falls back to IP if missing). */
export function koaHeaderKey(headerName: string) {
  const lower = headerName.toLowerCase();
  return (ctx: Context): string => {
    const value = ctx.get(lower);
    return value ? `${lower}:${value}` : koaIpKey(ctx);
  };
}

/**
 * Create a Koa middleware from an existing GoBouncerClient.
 *
 * @example
 * import { gobouncer } from 'gobouncer'
 * import { koaLimit } from 'gobouncer/koa'
 *
 * const limiter = gobouncer({ url: 'http://localhost:8080' })
 *
 * app.use(koaLimit(limiter, { max: 100, windowMs: 60000 }))
 */
export function koaLimit(
  client: GoBouncerClient,
  opts: KoaLimitOptions
) {
  const keyFn = opts.key ?? koaIpKey;
  const algorithm = opts.algorithm ?? 'sliding_window';

  return async (ctx: Context, next: Next) => {
    const key = keyFn(ctx);
    const result = await client.check(key, opts.max, opts.windowMs, algorithm);

    ctx.set('X-RateLimit-Limit', String(opts.max));
    ctx.set('X-RateLimit-Remaining', String(result.remaining));

    if (result.retry_after !== undefined) {
      const resetEpochSec = Math.ceil((Date.now() + result.retry_after) / 1000);
      ctx.set('X-RateLimit-Reset', String(resetEpochSec));
    }

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.retry_after ?? 0) / 1000));
      ctx.set('Retry-After', String(retryAfterSec));
      ctx.status = 429;
      ctx.body = {
        error: 'too many requests',
        retry_after_ms: result.retry_after ?? 0,
      };
      return;
    }

    await next();
  };
}

export function koaUse(
  client: GoBouncerClient,
  name: string,
  opts: Pick<KoaLimitOptions, 'key'> = {}
) {
  const policy = client.policies?.[name];

  if (policy) {
    const algorithm = normalizePolicyAlgorithm(policy.algorithm);
    const keyFn = opts.key ?? koaIpKey;

    return koaLimit(client, {
      max: policy.limit,
      windowMs: policy.windowMs,
      algorithm,
      key: (ctx) => namespacedPolicyKey(name, algorithm, keyFn(ctx)),
    });
  }

  const keyFn = opts.key ?? koaIpKey;

  return async (ctx: Context, next: Next) => {
    const result = await client.checkPolicy(keyFn(ctx), name);

    ctx.set('X-RateLimit-Policy', result.policy ?? name);
    ctx.set('X-RateLimit-Remaining', String(result.remaining));
    if (result.limit !== undefined) {
      ctx.set('X-RateLimit-Limit', String(result.limit));
    }

    if (result.retry_after !== undefined) {
      const resetEpochSec = Math.ceil((Date.now() + result.retry_after) / 1000);
      ctx.set('X-RateLimit-Reset', String(resetEpochSec));
    }

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.retry_after ?? 0) / 1000));
      ctx.set('Retry-After', String(retryAfterSec));
      ctx.status = 429;
      ctx.body = {
        error: 'too many requests',
        retry_after_ms: result.retry_after ?? 0,
      };
      return;
    }

    await next();
  };
}
