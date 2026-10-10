import { Redis } from "ioredis";

/**
 * A Redis connection tuned to FAIL FAST. Redis here is an optimisation (cache, shared rate limits,
 * cross-instance events), never the source of truth, so when it is slow or down we want an
 * immediate error that callers turn into "treat as a cache miss", not requests that hang.
 *  - enableOfflineQueue:false -> commands issued while disconnected fail at once instead of piling up
 *  - commandTimeout           -> a stuck command cannot hold a request for long
 *  - retryStrategy            -> keep reconnecting forever, backing off up to 5s
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 250,
    connectTimeout: 2000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
  // Without a listener, ioredis would crash the process on connection errors. Failures surface as
  // rejected commands, which every caller handles.
  client.on("error", () => {});
  return client;
}

/** Resolves true once the client is connected, false if it is not within `timeoutMs`. */
export function waitUntilReady(client: Redis, timeoutMs = 3000): Promise<boolean> {
  if (client.status === "ready") return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      client.off("ready", onReady);
      resolve(ok);
    };
    const onReady = () => done(true);
    client.on("ready", onReady);
  });
}
