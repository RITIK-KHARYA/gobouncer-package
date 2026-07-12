import type { Context } from "hono";
import type { Algorithm } from "./types";

/** Per-route options when calling `honoLimit(...)`. */
export interface HonoLimitOptions {
  /** Max requests allowed within the window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** How to derive the key for this route. Defaults to limiting by IP. */
  key?: HonoKeyFunc;
  /** Which algorithm to use. Defaults to "sliding_window". */
  algorithm?: Algorithm;
}

export type HonoKeyFunc = (c: Context) => string;