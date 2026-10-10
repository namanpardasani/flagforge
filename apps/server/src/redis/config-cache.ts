import type { Redis } from "ioredis";

export interface CachedConfig {
  version: number;
  etag: string;
  body: string;
}

/**
 * Caches the /sdk/v1/flags response per environment, so a poll costs zero database queries.
 *
 * The hard part of any cache is stale data. Two keys per environment solve it:
 *   cfg:<env>      the cached response (a hash with version, etag, body)
 *   cfgv:<env>     the "marker": the newest version anyone has announced (only ever goes up)
 *
 *  - A writer that changes the config sets the marker to the new version (after its DB commit).
 *  - A cached entry is only served if entry.version >= marker, so the moment the marker moves,
 *    old entries stop being served, on every server instance sharing this Redis.
 *  - A reader that loaded data from the DB before a change may try to cache it afterwards. The put
 *    script refuses to store an entry older than the marker (or older than what is already there),
 *    so a slow reader can never put stale data back.
 * Each operation is one Lua script, so Redis runs it atomically.
 */

const GET_LUA = `
local marker = tonumber(redis.call('GET', KEYS[2]) or '0')
local e = redis.call('HMGET', KEYS[1], 'version', 'etag', 'body')
if not e[1] then return nil end
if tonumber(e[1]) < marker then return nil end
return e
`;

const PUT_LUA = `
local marker = tonumber(redis.call('GET', KEYS[2]) or '0')
local v = tonumber(ARGV[1])
if v < marker then return 0 end
local cur = tonumber(redis.call('HGET', KEYS[1], 'version') or '-1')
if v < cur then return 0 end
redis.call('HSET', KEYS[1], 'version', ARGV[1], 'etag', ARGV[2], 'body', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

const MARK_LUA = `
local v = tonumber(ARGV[1])
local cur = tonumber(redis.call('GET', KEYS[2]) or '-1')
if v > cur then redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2]) end
local ev = tonumber(redis.call('HGET', KEYS[1], 'version') or '-1')
if ev < v then redis.call('DEL', KEYS[1]) end
return 1
`;

interface Scripts {
  cfgGet(entry: string, marker: string): Promise<[string, string, string] | null>;
  cfgPut(entry: string, marker: string, version: number, etag: string, body: string, ttl: number): Promise<number>;
  cfgMark(entry: string, marker: string, version: number, ttl: number): Promise<number>;
}

export class ConfigCache {
  readonly #redis: (Redis & Scripts) | null;
  readonly #entryTtlSec: number;
  readonly #markerTtlSec: number;

  /** `redis` null means caching is switched off: every get is a miss and writes do nothing. */
  constructor(redis: Redis | null, options: { entryTtlSec?: number; markerTtlSec?: number } = {}) {
    this.#entryTtlSec = options.entryTtlSec ?? 3600;
    this.#markerTtlSec = options.markerTtlSec ?? 86_400; // must outlive entries, or an old entry could come back to life
    if (redis) {
      redis.defineCommand("cfgGet", { numberOfKeys: 2, lua: GET_LUA });
      redis.defineCommand("cfgPut", { numberOfKeys: 2, lua: PUT_LUA });
      redis.defineCommand("cfgMark", { numberOfKeys: 2, lua: MARK_LUA });
    }
    this.#redis = redis as (Redis & Scripts) | null;
  }

  get enabled() {
    return this.#redis !== null;
  }

  static #keys(environmentId: string): [string, string] {
    return [`cfg:${environmentId}`, `cfgv:${environmentId}`];
  }

  /** The cached response if it is still current, else null. Redis trouble is just a miss. */
  async get(environmentId: string): Promise<CachedConfig | null> {
    if (!this.#redis) return null;
    try {
      const row = await this.#redis.cfgGet(...ConfigCache.#keys(environmentId));
      if (!row) return null;
      const version = Number(row[0]);
      return Number.isInteger(version) && row[1] && row[2] ? { version, etag: row[1], body: row[2] } : null;
    } catch {
      return null;
    }
  }

  /** Stores a response you just built from the database (refused if it is already out of date). */
  async put(environmentId: string, entry: CachedConfig): Promise<void> {
    if (!this.#redis) return;
    try {
      await this.#redis.cfgPut(...ConfigCache.#keys(environmentId), entry.version, entry.etag, entry.body, this.#entryTtlSec);
    } catch {
      // cache is best-effort
    }
  }

  /** Announce that the environment is now at `version`, invalidating anything older everywhere. */
  async markVersion(environmentId: string, version: number): Promise<void> {
    if (!this.#redis) return;
    try {
      await this.#redis.cfgMark(...ConfigCache.#keys(environmentId), version, this.#markerTtlSec);
    } catch {
      // If this fails the entry still expires (TTL), and SDKs hear about the change over the stream.
    }
  }
}
