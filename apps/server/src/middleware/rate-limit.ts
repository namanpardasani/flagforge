import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { AppError } from "../errors.js";
import type { RateLimiter, RateRule } from "../redis/rate-limit.js";

/** Hash identifiers (emails, IPs) before they become Redis keys, so no personal data sits in Redis. */
export const fingerprint = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

export const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? "unknown";

interface Options {
  /** Names the bucket, e.g. "login". Different names never share tokens. */
  name: string;
  rule: RateRule;
  /** What to limit by. Return undefined to skip limiting this request. */
  key: (req: Request) => string | undefined;
}

/**
 * Takes one token for the request's key. Out of tokens -> 429 with Retry-After.
 * The standard RateLimit-* headers tell well-behaved clients how much room they have left.
 */
export function rateLimit(limiter: RateLimiter, { name, rule, key }: Options): RequestHandler {
  return async (req, res, next) => {
    const k = key(req);
    if (k === undefined) return next();
    const result = await limiter.consume(`${name}:${k}`, rule);
    res.set("RateLimit-Limit", String(result.limit));
    res.set("RateLimit-Remaining", String(result.remaining));
    res.set("RateLimit-Reset", String(Math.ceil(result.resetMs / 1000)));
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      res.set("Retry-After", String(retryAfterSeconds));
      throw new AppError(429, "RATE_LIMITED", "Too many requests, slow down", { retryAfterSeconds });
    }
    next();
  };
}
