import { Context } from "elysia";
import { FastifyRequest } from "fastify";

/** Which rate limiting algorithm GoBouncer should use for this check. */
export type Algorithm = "sliding_window" | "gcra";

/** Minimal request shape we depend on — works with Express, Fastify (via req.raw), etc. */
export interface MinimalRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Minimal response shape we depend on — matches Express's res object. */
export interface MinimalResponse {
  setHeader(name: string, value: string | number): unknown;
  status(code: number): MinimalResponse;
  json(body: unknown): unknown;
}

/** Function that derives a unique rate-limit key from an incoming request. */
export type KeyFunc<Req extends MinimalRequest = MinimalRequest> = (
  req: Req
) => string;

/** The result GoBouncer returns for a single check. */
export interface CheckResult {
  allowed: boolean;
  remaining: number;
  retry_after?: number; // milliseconds
}

/** Options for creating a GoBouncer client. */
export interface GoBouncerOptions {
  /** Base URL of the running GoBouncer service, e.g. "http://localhost:8080" */
  url: string;
  /** Max time to wait for GoBouncer to respond, in ms. Default: 150. */
  timeoutMs?: number;
  /**
   * If GoBouncer is unreachable or errors out:
   *   true  (default) — allow the request through (availability over strictness)
   *   false            — deny the request (strictness over availability)
   */
  failOpen?: boolean;
  /** Optional shared secret sent as `X-GoBouncer-Key` header on every check call. */
  apiKey?: string;
  /** Optional callback triggered when GoBouncer is unreachable or returns an error. */
  onError?: (err: Error) => void;
}

/** Per-route options when calling `.limit(...)`. */
export interface LimitOptions<Req extends MinimalRequest = MinimalRequest> {
  /** Max requests allowed within the window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** How to derive the key for this route. Defaults to limiting by IP. */
  key?: KeyFunc<Req>;
  /** Which algorithm to use. Defaults to "sliding_window". */
  algorithm?: Algorithm;
}

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

export interface KoaLimitOptions {
  /** Max requests allowed within the window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** How to derive the key for this route. Defaults to limiting by IP. */
  key?: (ctx: Context) => string;
  /** Which algorithm to use. Defaults to "sliding_window". */
  algorithm?: Algorithm;
}

export interface NextLimitOptions {
  /** Max requests allowed within the window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Which algorithm to use. Defaults to "sliding_window". */
  algorithm?: Algorithm;
}

export interface NextLimitOptions {
  /** Max requests allowed within the window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** How to derive the key for this route. Defaults to limiting by IP. */
  key?: (req: Request) => string;
  /** Which algorithm to use. Defaults to "sliding_window". */
  algorithm?: Algorithm;
}
