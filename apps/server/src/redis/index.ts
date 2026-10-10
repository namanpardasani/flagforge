import { Redis } from "ioredis";
import type { Config } from "../config.js";
import { InMemoryEventBus, type EventBus } from "../realtime/bus.js";
import { createRedisClient, waitUntilReady } from "./client.js";
import { ConfigCache } from "./config-cache.js";
import { RedisEventBus } from "./event-bus.js";
import { KeyCache } from "./key-cache.js";
import { allowAll, MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./rate-limit.js";

export type RedisStatus = "disabled" | "up" | "down";

export interface RedisServices {
  /** False when no REDIS_URL is configured: everything still works, just without Redis features. */
  enabled: boolean;
  /** The shared command connection (null when disabled). Exposed for tests and health checks. */
  client: Redis | null;
  configCache: ConfigCache;
  keyCache: KeyCache;
  rateLimiter: RateLimiter;
  bus: EventBus;
  status(): Promise<RedisStatus>;
  waitUntilReady(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Builds everything that can use Redis. With no URL it returns in-memory equivalents, so the same
 * code path runs with or without Redis and the app never has to ask "is Redis there?".
 */
export function createRedisServices(config: Pick<Config, "REDIS_URL" | "RATE_LIMIT_ENABLED">): RedisServices {
  const url = config.REDIS_URL;
  const fallbackLimiter = new MemoryRateLimiter();

  if (!url) {
    return {
      enabled: false,
      client: null,
      configCache: new ConfigCache(null),
      keyCache: new KeyCache(null),
      rateLimiter: config.RATE_LIMIT_ENABLED ? fallbackLimiter : allowAll,
      bus: new InMemoryEventBus(),
      status: async () => "disabled",
      waitUntilReady: async () => true,
      close: async () => {},
    };
  }

  const client = createRedisClient(url);
  const pub = createRedisClient(url);
  // The subscriber keeps its offline queue so subscribe() calls made during startup are sent once connected.
  const sub = new Redis(url, { retryStrategy: (n) => Math.min(n * 200, 5000), connectTimeout: 2000 });
  sub.on("error", () => {});

  return {
    enabled: true,
    client,
    configCache: new ConfigCache(client),
    keyCache: new KeyCache(client),
    rateLimiter: config.RATE_LIMIT_ENABLED ? new RedisRateLimiter(client, fallbackLimiter) : allowAll,
    bus: new RedisEventBus(pub, sub),
    async status() {
      try {
        return (await client.ping()) === "PONG" ? "up" : "down";
      } catch {
        return "down";
      }
    },
    async waitUntilReady(timeoutMs = 3000) {
      const results = await Promise.all([client, pub, sub].map((c) => waitUntilReady(c, timeoutMs)));
      return results.every(Boolean);
    },
    async close() {
      const connections = [client, pub, sub];
      // Ask politely, but never wait long: if Redis is unreachable, QUIT can sit forever behind
      // queued commands (the subscriber keeps an offline queue), and shutdown must not hang on that.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(connections.map((c) => c.quit())),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      clearTimeout(timer);
      for (const c of connections) c.disconnect();
    },
  };
}
