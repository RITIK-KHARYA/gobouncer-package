import type { FastifyRequest, FastifyReply } from 'fastify';
import { GoBouncerClient } from './index';
import type { Algorithm } from './types';

export interface FastifyLimitOptions {
  /** Max requests allowed within the window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** How to derive the key for this route. Defaults to limiting by IP. */
  key?: (req: FastifyRequest) => string;
  /** Which algorithm to use. Defaults to "sliding_window". */
  algorithm?: Algorithm;
}

/** Default key function — limits by client IP address. */
export const fastifyIpKey = (req: FastifyRequest): string => {
  const ip = req.ip || 'unknown';
  return `ip:${ip}`;
};

/** Build a key function that reads a specific header (falls back to IP if missing). */
export function fastifyHeaderKey(headerName: string) {
  const lower = headerName.toLowerCase();
  return (req: FastifyRequest): string => {
    const value = req.headers[lower];
    const resolved = Array.isArray(value) ? value[0] : value;
    return resolved ? `${lower}:${resolved}` : fastifyIpKey(req);
  };
}

/**
 * Create a Fastify preHandler hook from an existing GoBouncerClient.
 *
 * @example
 * import { gobouncer } from 'gobouncer'
 * import { fastifyLimit } from 'gobouncer/fastify'
 *
 * const limiter = gobouncer({ url: 'http://localhost:8080' })
 *
 * fastify.get('/api', { preHandler: fastifyLimit(limiter, { max: 100, windowMs: 60000 }) }, handler)
 */
export function fastifyLimit(
  client: GoBouncerClient,
  opts: FastifyLimitOptions
) {
  const keyFn = opts.key ?? fastifyIpKey;
  const algorithm = opts.algorithm ?? 'sliding_window';

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = keyFn(req);
    const result = await client.check(key, opts.max, opts.windowMs, algorithm);

    reply.header('X-RateLimit-Limit', String(opts.max));
    reply.header('X-RateLimit-Remaining', String(result.remaining));

    if (result.retry_after !== undefined) {
      const resetEpochSec = Math.ceil((Date.now() + result.retry_after) / 1000);
      reply.header('X-RateLimit-Reset', String(resetEpochSec));
    }

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.retry_after ?? 0) / 1000));
      reply.header('Retry-After', String(retryAfterSec));
      reply.status(429).send({
        error: 'too many requests',
        retry_after_ms: result.retry_after ?? 0,
      });
    }
  };
}
