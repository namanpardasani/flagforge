import { beforeEach, describe, expect, it } from "vitest";
import { createRedisClient } from "../src/redis/client.js";
import { ConfigCache } from "../src/redis/config-cache.js";
import { KeyCache } from "../src/redis/key-cache.js";
import { testRedis } from "./helpers.js";

const redis = testRedis.client!;
const entry = (version: number, body = `{"v":${version}}`) => ({ version, etag: `"e${version}"`, body });

beforeEach(async () => {
  await redis.flushdb();
});

describe("ConfigCache", () => {
  it("misses when empty, then returns what was stored", async () => {
    const cache = new ConfigCache(redis);
    expect(await cache.get("env1")).toBeNull();
    await cache.put("env1", entry(3));
    expect(await cache.get("env1")).toEqual(entry(3));
  });

  it("keeps environments separate", async () => {
    const cache = new ConfigCache(redis);
    await cache.put("env1", entry(1, "one"));
    await cache.put("env2", entry(1, "two"));
    expect((await cache.get("env1"))!.body).toBe("one");
    expect((await cache.get("env2"))!.body).toBe("two");
  });

  it("stops serving an entry once a newer version is announced, on every instance sharing Redis", async () => {
    const a = new ConfigCache(redis);
    const b = new ConfigCache(redis); // another server instance
    await a.put("env1", entry(1));
    expect(await b.get("env1")).not.toBeNull();
    await b.markVersion("env1", 2);
    expect(await a.get("env1")).toBeNull();
    expect(await b.get("env1")).toBeNull();
  });

  it("refuses to cache data older than the announced version (a slow reader cannot put stale data back)", async () => {
    const cache = new ConfigCache(redis);
    // Reader loaded version 1 from the database...
    // ...then a change committed and announced version 2 before the reader tried to cache it.
    await cache.markVersion("env1", 2);
    await cache.put("env1", entry(1));
    expect(await cache.get("env1")).toBeNull();
    expect(await redis.exists("cfg:env1")).toBe(0);
    // The up-to-date data is accepted.
    await cache.put("env1", entry(2));
    expect(await cache.get("env1")).toEqual(entry(2));
  });

  it("never replaces a newer cached entry with an older one", async () => {
    const cache = new ConfigCache(redis);
    await cache.put("env1", entry(5, "new"));
    await cache.put("env1", entry(4, "old"));
    expect((await cache.get("env1"))!.body).toBe("new");
    await cache.put("env1", entry(5, "same-version rewrite"));
    expect((await cache.get("env1"))!.body).toBe("same-version rewrite");
  });

  it("the version marker only ever goes up", async () => {
    const cache = new ConfigCache(redis);
    await cache.markVersion("env1", 5);
    await cache.markVersion("env1", 3);
    expect(await redis.get("cfgv:env1")).toBe("5");
    await cache.put("env1", entry(4));
    expect(await cache.get("env1")).toBeNull();
  });

  it("deletes superseded entries when the marker moves (frees memory)", async () => {
    const cache = new ConfigCache(redis);
    await cache.put("env1", entry(1));
    await cache.markVersion("env1", 2);
    expect(await redis.exists("cfg:env1")).toBe(0);
  });

  it("expires entries, and the marker outlives them (an old entry cannot come back to life)", async () => {
    const cache = new ConfigCache(redis, { entryTtlSec: 100, markerTtlSec: 1000 });
    await cache.put("env1", entry(1));
    await cache.markVersion("env1", 1);
    const entryTtl = await redis.ttl("cfg:env1");
    const markerTtl = await redis.ttl("cfgv:env1");
    expect(entryTtl).toBeGreaterThan(0);
    expect(entryTtl).toBeLessThanOrEqual(100);
    expect(markerTtl).toBeGreaterThan(entryTtl);
  });

  it("handles many concurrent writers: the highest version always wins", async () => {
    const cache = new ConfigCache(redis);
    await Promise.all(Array.from({ length: 40 }, (_, i) => cache.put("env1", entry(i + 1))));
    expect((await cache.get("env1"))!.version).toBe(40);
  });

  it("is a harmless no-op when Redis is not configured", async () => {
    const cache = new ConfigCache(null);
    expect(cache.enabled).toBe(false);
    await cache.put("env1", entry(1));
    await cache.markVersion("env1", 2);
    expect(await cache.get("env1")).toBeNull();
  });

  it("treats a broken Redis as a miss instead of throwing", async () => {
    const dead = createRedisClient("redis://127.0.0.1:1");
    try {
      const cache = new ConfigCache(dead);
      await expect(cache.put("env1", entry(1))).resolves.toBeUndefined();
      await expect(cache.markVersion("env1", 2)).resolves.toBeUndefined();
      expect(await cache.get("env1")).toBeNull();
    } finally {
      dead.disconnect();
    }
  });
});

describe("KeyCache", () => {
  const meta = { apiKeyId: "k1", workspaceId: "w1", projectId: "p1", environmentId: "e1", environmentKey: "dev" };

  it("stores and returns key metadata, with a short TTL", async () => {
    const cache = new KeyCache(redis, { ttlSec: 30 });
    expect(await cache.get("hash1")).toBeNull();
    await cache.put("hash1", meta);
    expect(await cache.get("hash1")).toEqual(meta);
    const ttl = await redis.ttl("apikey:hash1");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it("invalidates one or many keys", async () => {
    const cache = new KeyCache(redis);
    await cache.put("a", meta);
    await cache.put("b", meta);
    await cache.put("c", meta);
    await cache.invalidate(["a", "b"]);
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("c")).toEqual(meta);
    await expect(cache.invalidate([])).resolves.toBeUndefined();
  });

  it("ignores corrupt cache contents", async () => {
    const cache = new KeyCache(redis);
    await redis.set("apikey:bad1", "not json");
    await redis.set("apikey:bad2", JSON.stringify({ apiKeyId: "k1" }));
    await redis.set("apikey:bad3", JSON.stringify({ ...meta, environmentId: 5 }));
    for (const h of ["bad1", "bad2", "bad3"]) expect(await cache.get(h)).toBeNull();
  });

  it("is a harmless no-op when disabled or when Redis is down", async () => {
    const off = new KeyCache(null);
    await off.put("a", meta);
    expect(await off.get("a")).toBeNull();
    await expect(off.invalidate(["a"])).resolves.toBeUndefined();

    const dead = createRedisClient("redis://127.0.0.1:1");
    try {
      const cache = new KeyCache(dead);
      await expect(cache.put("a", meta)).resolves.toBeUndefined();
      expect(await cache.get("a")).toBeNull();
      await expect(cache.invalidate(["a"])).resolves.toBeUndefined();
    } finally {
      dead.disconnect();
    }
  });
});
