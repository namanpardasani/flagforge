import type { Redis } from "ioredis";

export interface CachedKey {
  apiKeyId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  environmentKey: string;
}

/**
 * Remembers which tenant/environment an API key belongs to, so SDK requests skip the database.
 *
 * Only VALID keys are cached (an attacker guessing keys never fills it). A revoked key is deleted
 * from the cache the moment it is revoked, so revocation stays immediate; the short TTL is only a
 * backstop for cases where a key disappears without an explicit revoke (e.g. its environment is
 * deleted and we missed invalidating it).
 */
export class KeyCache {
  readonly #redis: Redis | null;
  readonly #ttlSec: number;

  constructor(redis: Redis | null, options: { ttlSec?: number } = {}) {
    this.#redis = redis;
    this.#ttlSec = options.ttlSec ?? 60;
  }

  static #key(keyHash: string) {
    return `apikey:${keyHash}`;
  }

  async get(keyHash: string): Promise<CachedKey | null> {
    if (!this.#redis) return null;
    try {
      const raw = await this.#redis.get(KeyCache.#key(keyHash));
      if (!raw) return null;
      const v = JSON.parse(raw) as Partial<CachedKey>;
      if (
        typeof v.apiKeyId === "string" &&
        typeof v.workspaceId === "string" &&
        typeof v.projectId === "string" &&
        typeof v.environmentId === "string" &&
        typeof v.environmentKey === "string"
      ) {
        return v as CachedKey;
      }
      return null;
    } catch {
      return null;
    }
  }

  async put(keyHash: string, value: CachedKey): Promise<void> {
    if (!this.#redis) return;
    try {
      await this.#redis.set(KeyCache.#key(keyHash), JSON.stringify(value), "EX", this.#ttlSec);
    } catch {
      // best-effort
    }
  }

  /** Remove keys from the cache (revocation, environment/project deletion). */
  async invalidate(keyHashes: string[]): Promise<void> {
    if (!this.#redis || keyHashes.length === 0) return;
    try {
      await this.#redis.del(...keyHashes.map(KeyCache.#key));
    } catch {
      // The TTL bounds how long a stale entry can survive a failed delete.
    }
  }
}
