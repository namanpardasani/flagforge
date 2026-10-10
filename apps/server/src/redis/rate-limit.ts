import type { Redis } from "ioredis";

/** "capacity" requests allowed per "windowMs", with bursts up to capacity (a token bucket). */
export interface RateRule {
  capacity: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until a request of this cost would be allowed (0 when allowed). */
  retryAfterMs: number;
  /** Milliseconds until the bucket is completely full again. */
  resetMs: number;
}

export interface RateLimiter {
  consume(key: string, rule: RateRule, cost?: number): Promise<RateLimitResult>;
}

/**
 * Token bucket: a bucket holds up to `capacity` tokens and refills at capacity/windowMs. Each request
 * takes one token; no token means "too many requests". Unlike a fixed window it has no boundary
 * burst (2x the limit across a window edge), and it allows short bursts up to capacity.
 * The pure maths lives here so the in-memory limiter and the Lua script cannot drift apart.
 */
export function refillAndTake(
  state: { tokens: number; ts: number } | undefined,
  rule: RateRule,
  now: number,
  cost: number,
): { tokens: number; result: RateLimitResult } {
  const perMs = rule.capacity / rule.windowMs;
  let tokens = state ? Math.min(rule.capacity, state.tokens + Math.max(0, now - state.ts) * perMs) : rule.capacity;
  const allowed = tokens >= cost;
  if (allowed) tokens -= cost;
  return {
    tokens,
    result: {
      allowed,
      limit: rule.capacity,
      remaining: Math.floor(tokens),
      retryAfterMs: allowed ? 0 : Math.ceil((cost - tokens) / perMs),
      resetMs: Math.ceil((rule.capacity - tokens) / perMs),
    },
  };
}

/** Per-process limiter. Used when Redis is not configured, and as the fallback when Redis fails. */
export class MemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; ts: number; fullAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  async consume(key: string, rule: RateRule, cost = 1): Promise<RateLimitResult> {
    const now = this.now();
    const { tokens, result } = refillAndTake(this.#buckets.get(key), rule, now, cost);
    this.#buckets.delete(key); // re-insert so the Map stays ordered by recency
    this.#buckets.set(key, { tokens, ts: now, fullAt: now + result.resetMs });
    if (this.#buckets.size > this.maxKeys) this.#evict(now);
    return result;
  }

  /** Bounded memory: drop buckets that have fully refilled (they carry no information), then the oldest. */
  #evict(now: number) {
    for (const [k, b] of this.#buckets) if (b.fullAt <= now) this.#buckets.delete(k);
    for (const k of this.#buckets.keys()) {
      if (this.#buckets.size <= this.maxKeys) break;
      this.#buckets.delete(k);
    }
  }

  get size() {
    return this.#buckets.size;
  }
}

const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local per_ms = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil then tokens = capacity else tokens = math.min(capacity, tokens + math.max(0, now - ts) * per_ms) end
local allowed = 0
local retry = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 else retry = math.ceil((cost - tokens) / per_ms) end
redis.call('HSET', KEYS[1], 'tokens', string.format('%.6f', tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / per_ms) + 1000)
return { allowed, math.floor(tokens), retry, math.ceil((capacity - tokens) / per_ms) }
`;

interface BucketScript {
  tokenBucket(key: string, capacity: number, perMs: number, cost: number): Promise<[number, number, number, number]>;
}

/**
 * Shared limiter: one Lua script per request, so concurrent requests on many servers can never
 * both take the last token. Uses Redis's own clock so servers with skewed clocks agree.
 * If Redis errors, it falls back to the local limiter: degraded (limits become per-server) but
 * never switched off, which matters for brute-force protection on login.
 */
export class RedisRateLimiter implements RateLimiter {
  readonly #redis: Redis & BucketScript;

  constructor(
    redis: Redis,
    private readonly fallback: RateLimiter = new MemoryRateLimiter(),
    private readonly prefix = "rl:",
  ) {
    redis.defineCommand("tokenBucket", { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
    this.#redis = redis as Redis & BucketScript;
  }

  async consume(key: string, rule: RateRule, cost = 1): Promise<RateLimitResult> {
    try {
      const [allowed, remaining, retryAfterMs, resetMs] = await this.#redis.tokenBucket(
        this.prefix + key,
        rule.capacity,
        rule.capacity / rule.windowMs,
        cost,
      );
      return { allowed: allowed === 1, limit: rule.capacity, remaining, retryAfterMs, resetMs };
    } catch {
      return this.fallback.consume(key, rule, cost);
    }
  }
}

/** Used when rate limiting is switched off (e.g. load tests). */
export const allowAll: RateLimiter = {
  async consume(_key, rule) {
    return { allowed: true, limit: rule.capacity, remaining: rule.capacity, retryAfterMs: 0, resetMs: 0 };
  },
};
