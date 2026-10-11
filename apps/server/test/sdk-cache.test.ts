import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth/tokens.js";
import { InMemoryEventBus, envTopic } from "../src/realtime/bus.js";
import { announce } from "../src/realtime/versions.js";
import type { CachedConfig } from "../src/redis/config-cache.js";
import { createRedisServices } from "../src/redis/index.js";
import { makeApp, prisma, registerUser, resetDb, testRedis, type TestUser } from "./helpers.js";

const app = makeApp();
const redis = testRedis.client!;

let owner: TestUser;
let wsId: string;
let projectId: string;
let flagId: string;
let devId: string;
let prodId: string;
let devKey: string;

const api = (method: "post" | "put" | "delete" | "get", path: string, body?: object, a = app) => {
  const r = request(a)[method](path).set("Authorization", owner.auth);
  return body ? r.send(body) : r;
};
const configure = (envId: string, body: object, a = app) =>
  api("put", `/workspaces/${wsId}/projects/${projectId}/flags/${flagId}/environments/${envId}`, body, a);
const sdkFlags = (key = devKey, a = app) => request(a).get("/sdk/v1/flags").set("Authorization", `Bearer ${key}`);
const mkKey = async (envId: string) =>
  (await api("post", `/workspaces/${wsId}/projects/${projectId}/environments/${envId}/api-keys`, { name: "k" })).body as { id: string; key: string };
const dbCalls = () => [
  vi.spyOn(prisma.apiKey, "findUnique"),
  vi.spyOn(prisma.environment, "findFirst"),
  vi.spyOn(prisma.flag, "findMany"),
];
const totalCalls = (spies: ReturnType<typeof dbCalls>) => spies.reduce((n, s) => n + s.mock.calls.length, 0);

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  owner = await registerUser(app, "owner@example.com");
  wsId = (await api("post", "/workspaces", { name: "Acme", slug: "acme" })).body.id;
  const project = (await api("post", `/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = project.id;
  devId = project.environments.find((e: { key: string }) => e.key === "dev").id;
  prodId = project.environments.find((e: { key: string }) => e.key === "prod").id;
  flagId = (await api("post", `/workspaces/${wsId}/projects/${projectId}/flags`, { key: "checkout", name: "C" })).body.id;
  devKey = (await mkKey(devId)).key;
});

describe("server-side evaluation uses the same cached configuration", () => {
  const evaluate = (key: string, userKey = "u1") => request(app).post("/sdk/v1/evaluate").set("Authorization", `Bearer ${key}`).send({ flagKey: "checkout", context: { key: userKey } });
  const evaluateAll = (key: string) => request(app).post("/sdk/v1/evaluate-all").set("Authorization", `Bearer ${key}`).send({ context: { key: "u1" } });

  it("costs ZERO database queries once the environment is warm", async () => {
    expect((await evaluate(devKey)).status).toBe(200); // warms key cache and config cache
    const spies = dbCalls();
    const singleFlagLookups = vi.spyOn(prisma.flag, "findFirst");
    for (let i = 0; i < 5; i++) expect((await evaluate(devKey, `user-${i}`)).status).toBe(200);
    expect((await evaluateAll(devKey)).status).toBe(200);
    expect(totalCalls(spies) + singleFlagLookups.mock.calls.length).toBe(0);
  });

  it("answers with a change the moment it has been made (never a stale cached answer)", async () => {
    expect((await evaluate(devKey)).body).toMatchObject({ value: false, reason: "OFF" });
    await configure(devId, { enabled: true });
    expect((await evaluate(devKey)).body).toMatchObject({ value: true, reason: "FALLTHROUGH" });
    await configure(devId, { enabled: false });
    expect((await evaluate(devKey)).body).toMatchObject({ value: false, reason: "OFF" });
    expect((await evaluateAll(devKey)).body.flags.checkout).toMatchObject({ value: false });
  });

  it("keeps environments apart: a flag on in dev is not on for a prod key", async () => {
    const prodKey = (await mkKey(prodId)).key;
    await configure(devId, { enabled: true });
    // Warm both, in both orders, so a shared cache entry would show up.
    for (let i = 0; i < 2; i++) {
      expect((await evaluate(devKey)).body.value).toBe(true);
      expect((await evaluate(prodKey)).body.value).toBe(false);
    }
  });

  it("agrees with what an SDK computes locally from the downloaded configuration", async () => {
    await configure(devId, { enabled: true, rolloutPercentage: 50 });
    const { evaluateFlag } = await import("@flagforge/core");
    const config = (await sdkFlags()).body.flags[0];
    for (let i = 0; i < 40; i++) {
      const local = evaluateFlag(config, { key: `user-${i}` });
      expect((await evaluate(devKey, `user-${i}`)).body).toMatchObject({ value: local.value, reason: local.reason });
    }
  });

  it("reports an unknown flag as 404, and picks up a flag created afterwards", async () => {
    const unknown = () => request(app).post("/sdk/v1/evaluate").set("Authorization", `Bearer ${devKey}`).send({ flagKey: "brand-new", context: { key: "u1" } });
    expect((await unknown()).status).toBe(404);
    await api("post", `/workspaces/${wsId}/projects/${projectId}/flags`, { key: "brand-new", name: "N" });
    expect((await unknown()).status).toBe(200);
  });
});

describe("config cache", () => {
  it("serves repeat polls with ZERO database queries", async () => {
    expect((await sdkFlags()).status).toBe(200); // warms key cache and config cache
    const spies = dbCalls();
    for (let i = 0; i < 5; i++) expect((await sdkFlags()).status).toBe(200);
    expect(totalCalls(spies)).toBe(0);
  });

  it("really serves from the cache: a change made behind its back is not visible until the cache is told", async () => {
    const first = await sdkFlags();
    expect(first.body.flags[0].fallthroughBps).toBe(10000);
    // Out-of-band edit that bypasses the API (and therefore the version bump and cache marker).
    await prisma.flagState.upsert({
      where: { flagId_environmentId: { flagId, environmentId: devId } },
      create: { flagId, environmentId: devId, workspaceId: wsId, enabled: false, fallthroughBps: 5000 },
      update: { fallthroughBps: 5000 },
    });
    expect((await sdkFlags()).body.flags[0].fallthroughBps).toBe(10000); // still the cached copy
    // A real change through the API announces itself and the cache refreshes from the database
    // (which now also shows the out-of-band edit).
    await configure(devId, { enabled: true });
    const fresh = await sdkFlags();
    expect(fresh.body.flags[0]).toMatchObject({ enabled: true, fallthroughBps: 5000 });
    expect(fresh.body.version).toBe(first.body.version + 1);
  });

  it("stores the entry with a version, and moves the marker on every change", async () => {
    const res = await sdkFlags();
    expect(await redis.hget(`cfg:${devId}`, "version")).toBe(String(res.body.version));
    await configure(devId, { enabled: true });
    expect(await redis.get(`cfgv:${devId}`)).toBe(String(res.body.version + 1));
    expect(await redis.exists(`cfg:${devId}`)).toBe(0); // the superseded entry was dropped
  });

  it("keeps ETags stable and answers 304 straight from the cache", async () => {
    const first = await sdkFlags();
    const etag = first.headers["etag"]!;
    const again = await sdkFlags();
    expect(again.headers["etag"]).toBe(etag);
    expect(again.text).toBe(first.text); // byte-identical body
    const spies = dbCalls();
    const conditional = await request(app).get("/sdk/v1/flags").set("Authorization", `Bearer ${devKey}`).set("If-None-Match", etag);
    expect(conditional.status).toBe(304);
    expect(totalCalls(spies)).toBe(0);
  });

  it("environments never see each other's cached config", async () => {
    const prodKey = (await mkKey(prodId)).key;
    await configure(devId, { enabled: true });
    expect((await sdkFlags(devKey)).body.flags[0].enabled).toBe(true);
    expect((await sdkFlags(prodKey)).body.flags[0].enabled).toBe(false);
    await configure(prodId, { enabled: true, rolloutPercentage: 10 });
    const dev = await sdkFlags(devKey);
    const prod = await sdkFlags(prodKey);
    expect(dev.body.flags[0].fallthroughBps).toBe(10000);
    expect(prod.body.flags[0].fallthroughBps).toBe(1000);
  });

  it("a slow reader cannot put stale data into the cache after a newer version was announced", async () => {
    const current = (await sdkFlags()).body.version as number;
    await redis.flushdb();
    await testRedis.configCache.markVersion(devId, current + 5); // a newer version has been announced elsewhere
    const res = await sdkFlags(); // loads (older) data from the database
    expect(res.status).toBe(200);
    expect(res.body.flags).toHaveLength(1); // still answers correctly from the database
    expect(await redis.exists(`cfg:${devId}`)).toBe(0); // but refuses to cache it
  });

  it("two server instances share the cache and its invalidation", async () => {
    const a = makeApp();
    const b = makeApp();
    expect((await sdkFlags(devKey, a)).body.flags[0].enabled).toBe(false); // A caches it
    await configure(devId, { enabled: true }, b); // B changes it
    expect((await sdkFlags(devKey, a)).body.flags[0].enabled).toBe(true); // A must not serve the old copy
  });

  it("never serves stale data under concurrent changes and reads (stress)", async () => {
    let expected = false;
    for (let round = 0; round < 25; round++) {
      expected = !expected;
      const [change] = await Promise.all([configure(devId, { enabled: expected }), sdkFlags(), sdkFlags(), sdkFlags()]);
      expect(change.status).toBe(200);
      // After the change has returned, no read may ever show the previous value again.
      const reads = await Promise.all([sdkFlags(), sdkFlags(), sdkFlags()]);
      for (const r of reads) expect(r.body.flags[0].enabled, `round ${round}`).toBe(expected);
    }
    const dbVersion = (await prisma.environment.findUniqueOrThrow({ where: { id: devId } })).configVersion;
    expect((await sdkFlags()).body.version).toBe(dbVersion);
  });
});

describe("announcing a change", () => {
  it("moves the cache marker BEFORE publishing, so an SDK that refetches the instant it hears the event cannot get the stale cached copy", async () => {
    const env = "env-order-test";
    await testRedis.configCache.put(env, { version: 1, etag: '"e1"', body: '{"v":1}' });
    const bus = new InMemoryEventBus();
    let seen: CachedConfig | null | "pending" = "pending";
    // This is what a refetching SDK effectively does the moment the event arrives.
    bus.subscribe(envTopic(env), async () => {
      seen = await testRedis.configCache.get(env);
    });
    await announce({ bus, cache: testRedis.configCache }, [{ environmentId: env, version: 2 }]);
    await vi.waitFor(() => expect(seen).not.toBe("pending"), { timeout: 2000 });
    expect(seen).toBeNull(); // the version-1 entry must already be invalid when the event is delivered
  });

  it("still delivers the event when the cache is unavailable", async () => {
    const { ConfigCache } = await import("../src/redis/config-cache.js");
    const bus = new InMemoryEventBus();
    const versions: number[] = [];
    bus.subscribe(envTopic("e"), (m) => void (m.type === "config" && versions.push(m.version)));
    await announce({ bus, cache: new ConfigCache(null) }, [{ environmentId: "e", version: 4 }]);
    expect(versions).toEqual([4]);
  });
});

describe("API key cache", () => {
  it("caches a valid key (metadata only, never the secret) with a short TTL", async () => {
    await sdkFlags();
    const hash = hashToken(devKey);
    const raw = await redis.get(`apikey:${hash}`);
    expect(raw).toBeTruthy();
    expect(Object.keys(JSON.parse(raw!)).sort()).toEqual(["apiKeyId", "environmentId", "environmentKey", "projectId", "workspaceId"]);
    expect(await redis.ttl(`apikey:${hash}`)).toBeLessThanOrEqual(60);
    // The raw key must not appear anywhere in Redis.
    for (const k of await redis.keys("*")) {
      const type = await redis.type(k);
      const dump = type === "hash" ? JSON.stringify(await redis.hgetall(k)) : type === "string" ? await redis.get(k) : "";
      expect(k).not.toContain(devKey);
      expect(dump ?? "").not.toContain(devKey);
    }
  });

  it("skips the database for a cached key", async () => {
    await sdkFlags();
    const spy = vi.spyOn(prisma.apiKey, "findUnique");
    await sdkFlags();
    expect(spy).not.toHaveBeenCalled();
  });

  it("never caches invalid keys", async () => {
    for (let i = 0; i < 3; i++) expect((await sdkFlags(`ff_bogus_${i}_aaaaaaaaaaaaaaaaaaaa`)).status).toBe(401);
    expect(await redis.keys("apikey:*")).toHaveLength(0);
  });

  it("revocation is immediate even though the key was cached", async () => {
    const extra = await mkKey(devId);
    expect((await sdkFlags(extra.key)).status).toBe(200);
    expect(await redis.exists(`apikey:${hashToken(extra.key)}`)).toBe(1);
    await api("delete", `/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys/${extra.id}`);
    expect(await redis.exists(`apikey:${hashToken(extra.key)}`)).toBe(0);
    const res = await sdkFlags(extra.key);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_API_KEY");
    expect((await sdkFlags(devKey)).status).toBe(200); // other keys unaffected
  });

  it("revocation on one instance takes effect on another instance (shared Redis)", async () => {
    const a = makeApp();
    const b = makeApp();
    const extra = await mkKey(devId);
    expect((await sdkFlags(extra.key, a)).status).toBe(200);
    await api("delete", `/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys/${extra.id}`, undefined, b);
    expect((await sdkFlags(extra.key, a)).status).toBe(401);
  });

  it("deleting an environment or a project invalidates its cached keys immediately", async () => {
    const prodKey = (await mkKey(prodId)).key;
    expect((await sdkFlags(prodKey)).status).toBe(200);
    await api("delete", `/workspaces/${wsId}/projects/${projectId}/environments/${prodId}`);
    expect((await sdkFlags(prodKey)).status).toBe(401);

    expect((await sdkFlags(devKey)).status).toBe(200);
    await api("delete", `/workspaces/${wsId}/projects/${projectId}`);
    expect((await sdkFlags(devKey)).status).toBe(401);
  });

  it("a cached key from one tenant never grants access to another tenant's data", async () => {
    const other = await registerUser(app, "other@example.com");
    const otherWs = (await request(app).post("/workspaces").set("Authorization", other.auth).send({ name: "O", slug: "other-co" })).body.id;
    const otherProject = (await request(app).post(`/workspaces/${otherWs}/projects`).set("Authorization", other.auth).send({ name: "P", key: "pp" })).body;
    await request(app).post(`/workspaces/${otherWs}/projects/${otherProject.id}/flags`).set("Authorization", other.auth).send({ key: "secret-flag", name: "S" });
    const otherKey = (await request(app).post(`/workspaces/${otherWs}/projects/${otherProject.id}/environments/${otherProject.environments[0].id}/api-keys`).set("Authorization", other.auth).send({ name: "k" })).body.key;

    await sdkFlags(devKey);
    await sdkFlags(devKey);
    const theirs = await sdkFlags(otherKey);
    expect(JSON.stringify(theirs.body)).not.toContain("checkout");
    expect(JSON.stringify((await sdkFlags(devKey)).body)).not.toContain("secret-flag");
  });
});

describe("when Redis is down", () => {
  it("everything still works, straight from the database", async () => {
    const dead = createRedisServices({ REDIS_URL: "redis://127.0.0.1:1", RATE_LIMIT_ENABLED: true });
    try {
      const degraded = makeApp({ redis: dead });
      const first = await sdkFlags(devKey, degraded);
      expect(first.status).toBe(200);
      expect(first.body.flags).toHaveLength(1);

      const spy = vi.spyOn(prisma.apiKey, "findUnique");
      await sdkFlags(devKey, degraded);
      expect(spy).toHaveBeenCalled(); // no cache, so it hits the database every time

      await configure(devId, { enabled: true }, degraded); // writes work too
      expect((await sdkFlags(devKey, degraded)).body.flags[0].enabled).toBe(true);
      expect((await request(degraded).get("/auth/me").set("Authorization", owner.auth)).status).toBe(200);
    } finally {
      await dead.close();
    }
  });

  it("without any REDIS_URL the app behaves the same (Redis is optional)", async () => {
    const none = createRedisServices({ REDIS_URL: undefined, RATE_LIMIT_ENABLED: true });
    const app2 = makeApp({ redis: none });
    expect((await sdkFlags(devKey, app2)).status).toBe(200);
    await configure(devId, { enabled: true }, app2);
    expect((await sdkFlags(devKey, app2)).body.flags[0].enabled).toBe(true);
  });
});
