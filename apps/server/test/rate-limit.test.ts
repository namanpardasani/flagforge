import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRedisServices } from "../src/redis/index.js";
import { createRedisClient } from "../src/redis/client.js";
import { MemoryRateLimiter, RedisRateLimiter, allowAll, refillAndTake } from "../src/redis/rate-limit.js";
import { makeApp, noLimits, prisma, registerUser, resetDb, testConfig, testRedis } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rule = (capacity: number, windowMs: number) => ({ capacity, windowMs });

describe("token bucket maths", () => {
  it("starts full, spends one token per request, and reports the wait when empty", () => {
    const r = rule(5, 5000); // 1 token per second
    let state: { tokens: number; ts: number } | undefined;
    for (let i = 0; i < 5; i++) {
      const out = refillAndTake(state, r, 1000, 1);
      expect(out.result.allowed).toBe(true);
      expect(out.result.remaining).toBe(4 - i);
      state = { tokens: out.tokens, ts: 1000 };
    }
    const blocked = refillAndTake(state, r, 1000, 1);
    expect(blocked.result).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 1000, resetMs: 5000 });
  });

  it("refills over time but never above capacity", () => {
    const r = rule(5, 5000);
    const empty = { tokens: 0, ts: 0 };
    expect(refillAndTake(empty, r, 2000, 1).result).toMatchObject({ allowed: true, remaining: 1 }); // 2 refilled, 1 spent
    expect(refillAndTake(empty, r, 1_000_000, 1).result.remaining).toBe(4); // capped at 5, 1 spent
  });

  it("has no boundary burst: a full window right after exhausting the bucket allows only the refill", () => {
    const r = rule(10, 10_000);
    let state: { tokens: number; ts: number } | undefined;
    let t = 0;
    for (let i = 0; i < 10; i++) state = { tokens: refillAndTake(state, r, t, 1).tokens, ts: t };
    t = 500; // half a second later: only 0.5 tokens back
    expect(refillAndTake(state, r, t, 1).result.allowed).toBe(false);
    t = 1000; // one full token back
    expect(refillAndTake(state, r, t, 1).result.allowed).toBe(true);
  });
});

describe("MemoryRateLimiter", () => {
  it("limits per key, refills with time, and isolates keys", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    const r = rule(3, 3000);
    for (let i = 0; i < 3; i++) expect((await limiter.consume("a", r)).allowed).toBe(true);
    const blocked = await limiter.consume("a", r);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
    expect((await limiter.consume("b", r)).allowed).toBe(true); // other key untouched
    now += 1000;
    expect((await limiter.consume("a", r)).allowed).toBe(true);
    expect((await limiter.consume("a", r)).allowed).toBe(false);
  });

  it("bounds its memory: fully refilled buckets are dropped first, then the oldest", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now, 100);
    for (let i = 0; i < 100; i++) await limiter.consume(`k${i}`, rule(1000, 1000));
    expect(limiter.size).toBe(100);
    now += 10_000; // every bucket has refilled
    await limiter.consume("fresh", rule(1000, 1000));
    expect(limiter.size).toBeLessThanOrEqual(100);
    // Still bounded when nothing has refilled.
    for (let i = 0; i < 300; i++) await limiter.consume(`busy${i}`, rule(1, 1_000_000));
    expect(limiter.size).toBeLessThanOrEqual(100);
  });
});

describe("RedisRateLimiter", () => {
  beforeEach(async () => {
    await testRedis.client!.flushdb();
  });
  const limiter = () => new RedisRateLimiter(testRedis.client!);

  it("allows exactly `capacity` requests when many arrive at once (atomic, no double-spend)", async () => {
    const l = limiter();
    const results = await Promise.all(Array.from({ length: 60 }, () => l.consume("burst", rule(10, 60_000))));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(50);
  });

  it("two limiter instances sharing Redis share the budget (that is the point of Redis)", async () => {
    const a = limiter();
    const b = limiter();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).consume("shared", rule(8, 60_000))),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(8);
  });

  it("reports remaining tokens and a sensible retry time, and refills", async () => {
    const l = limiter();
    const r = rule(2, 400); // one token per 200ms
    expect(await l.consume("k", r)).toMatchObject({ allowed: true, remaining: 1, limit: 2 });
    expect(await l.consume("k", r)).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = await l.consume("k", r);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(200);
    await sleep(blocked.retryAfterMs + 60);
    expect((await l.consume("k", r)).allowed).toBe(true);
  });

  it("isolates keys and expires idle buckets (no unbounded growth)", async () => {
    const l = limiter();
    await l.consume("one", rule(1, 60_000));
    expect((await l.consume("one", rule(1, 60_000))).allowed).toBe(false);
    expect((await l.consume("two", rule(1, 60_000))).allowed).toBe(true);
    const ttl = await testRedis.client!.pttl("rl:one");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(61_000);
  });

  it("falls back to a local limiter if Redis fails, so limits are never switched off", async () => {
    const dead = createRedisClient("redis://127.0.0.1:1");
    try {
      const l = new RedisRateLimiter(dead, new MemoryRateLimiter());
      const results = [];
      for (let i = 0; i < 8; i++) results.push(await l.consume("k", rule(3, 60_000)));
      expect(results.filter((r) => r.allowed)).toHaveLength(3);
    } finally {
      dead.disconnect();
    }
  });

  it("allowAll never blocks", async () => {
    for (let i = 0; i < 5; i++) expect((await allowAll.consume("k", rule(1, 1000))).allowed).toBe(true);
  });
});

describe("rate limits over HTTP", () => {
  beforeEach(resetDb);
  const login = (app: ReturnType<typeof makeApp>, email: string, password = "wrong-password-123", headers: Record<string, string> = {}) => {
    const r = request(app).post("/auth/login");
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r.send({ email, password });
  };

  it("blocks password guessing against one account after 5 tries, with Retry-After and a clear error", async () => {
    const app = makeApp({ limits: { ...noLimits, login: rule(5, 15 * 60_000) } });
    await registerUser(app, "victim@example.com");
    for (let i = 0; i < 5; i++) expect((await login(app, "victim@example.com")).status).toBe(401);
    const blocked = await login(app, "victim@example.com");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(blocked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.headers["ratelimit-limit"]).toBe("5");
    expect(blocked.headers["ratelimit-remaining"]).toBe("0");
    // Even the CORRECT password is refused while limited: that is what makes brute force useless.
    expect((await login(app, "victim@example.com", "correct horse battery")).status).toBe(429);
  });

  it("does not let one account's lockout affect other accounts from the same address", async () => {
    const app = makeApp({ limits: { ...noLimits, login: rule(2, 15 * 60_000) } });
    await registerUser(app, "a@example.com");
    await registerUser(app, "b@example.com");
    for (let i = 0; i < 2; i++) await login(app, "a@example.com");
    expect((await login(app, "a@example.com")).status).toBe(429);
    expect((await login(app, "b@example.com", "correct horse battery")).status).toBe(200);
  });

  it("treats email case/whitespace variants as the same account", async () => {
    const app = makeApp({ limits: { ...noLimits, login: rule(2, 15 * 60_000) } });
    await login(app, "Same@Example.com");
    await login(app, "  same@example.com ");
    expect((await login(app, "SAME@EXAMPLE.COM")).status).toBe(429);
  });

  it("caps guessing across many accounts from one address", async () => {
    const app = makeApp({ limits: { ...noLimits, loginPerIp: rule(4, 15 * 60_000) } });
    for (let i = 0; i < 4; i++) expect((await login(app, `user${i}@example.com`)).status).toBe(401);
    expect((await login(app, "user99@example.com")).status).toBe(429);
  });

  it("limits by the real client IP behind a trusted proxy, and cannot be bypassed by spoofing when no proxy is trusted", async () => {
    const limits = { ...noLimits, login: rule(2, 15 * 60_000) };
    const behindProxy = makeApp({ config: { ...testConfig, TRUST_PROXY: 1 }, limits });
    for (let i = 0; i < 2; i++) await login(behindProxy, "x@example.com", "bad-password-1", { "X-Forwarded-For": "203.0.113.5" });
    expect((await login(behindProxy, "x@example.com", "bad-password-1", { "X-Forwarded-For": "203.0.113.5" })).status).toBe(429);
    // A different real client (as the proxy reports it) has its own budget.
    expect((await login(behindProxy, "x@example.com", "bad-password-1", { "X-Forwarded-For": "203.0.113.99" })).status).toBe(401);

    // No trusted proxy: the header is attacker-controlled and must be ignored, or limits are trivially bypassed.
    const direct = makeApp({ config: { ...testConfig, TRUST_PROXY: 0 }, limits });
    for (let i = 0; i < 2; i++) await login(direct, "y@example.com", "bad-password-1", { "X-Forwarded-For": `198.51.100.${i}` });
    expect((await login(direct, "y@example.com", "bad-password-1", { "X-Forwarded-For": "198.51.100.77" })).status).toBe(429);
  });

  it("limits registration per address", async () => {
    const app = makeApp({ limits: { ...noLimits, register: rule(2, 60 * 60_000) } });
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post("/auth/register").send({ email: `n${i}@example.com`, password: "correct horse battery", name: "N" })).status).toBe(201);
    }
    const res = await request(app).post("/auth/register").send({ email: "n3@example.com", password: "correct horse battery", name: "N" });
    expect(res.status).toBe(429);
    expect(await prisma.user.count()).toBe(2);
  });

  it("limits refresh and logout together, and counts malformed requests too", async () => {
    const app = makeApp({ limits: { ...noLimits, refresh: rule(3, 60_000) } });
    for (let i = 0; i < 3; i++) expect((await request(app).post("/auth/refresh").send({})).status).toBe(400); // invalid body still costs a token
    expect((await request(app).post("/auth/refresh").send({ refreshToken: "x" })).status).toBe(429);
    expect((await request(app).post("/auth/logout").send({ refreshToken: "x" })).status).toBe(429);
  });

  it("applies a global per-IP limit to the management API but never to /health or /sdk", async () => {
    const app = makeApp({ limits: { ...noLimits, global: rule(3, 60_000) } });
    for (let i = 0; i < 3; i++) expect((await request(app).get("/workspaces")).status).toBe(401);
    expect((await request(app).get("/workspaces")).status).toBe(429);
    for (let i = 0; i < 10; i++) expect((await request(app).get("/health")).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await request(app).get("/sdk/v1/flags")).status).toBe(401); // 401, not 429
  });

  it("recovers after the window: tokens refill", async () => {
    const app = makeApp({ limits: { ...noLimits, login: rule(2, 400) } });
    for (let i = 0; i < 2; i++) await login(app, "r@example.com");
    const blocked = await login(app, "r@example.com");
    expect(blocked.status).toBe(429);
    await sleep(Number(blocked.headers["retry-after"]) * 1000 + 100);
    expect((await login(app, "r@example.com")).status).toBe(401); // allowed through (wrong password)
  });

  it("falls back to per-instance limits when Redis is down, instead of dropping protection", async () => {
    const dead = createRedisServices({ REDIS_URL: "redis://127.0.0.1:1", RATE_LIMIT_ENABLED: true });
    try {
      const app = makeApp({ redis: dead, limits: { ...noLimits, login: rule(2, 15 * 60_000) } });
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await login(app, "d@example.com")).status);
      expect(statuses).toEqual([401, 401, 429, 429]);
    } finally {
      await dead.close();
    }
  });

  it("is switched off entirely with RATE_LIMIT_ENABLED=false", async () => {
    const off = createRedisServices({ REDIS_URL: process.env["TEST_REDIS_URL"], RATE_LIMIT_ENABLED: false });
    try {
      const app = makeApp({ redis: off, limits: { ...noLimits, login: rule(1, 60_000) } });
      for (let i = 0; i < 5; i++) expect((await login(app, "o@example.com")).status).toBe(401);
    } finally {
      await off.close();
    }
  });
});

describe("SDK rate limits", () => {
  beforeEach(resetDb);

  async function setup(app: ReturnType<typeof makeApp>) {
    const owner = await registerUser(app, "owner@example.com");
    const auth = { Authorization: owner.auth };
    const ws = (await request(app).post("/workspaces").set(auth).send({ name: "A", slug: "acme" })).body.id;
    const project = (await request(app).post(`/workspaces/${ws}/projects`).set(auth).send({ name: "P", key: "proj" })).body;
    const mk = async (i: number) =>
      (await request(app).post(`/workspaces/${ws}/projects/${project.id}/environments/${project.environments[i].id}/api-keys`).set(auth).send({ name: "k" })).body.key as string;
    await request(app).post(`/workspaces/${ws}/projects/${project.id}/flags`).set(auth).send({ key: "f-one", name: "F" });
    return { devKey: await mk(0), prodKey: await mk(2) };
  }
  const flags = (app: ReturnType<typeof makeApp>, key: string) => request(app).get("/sdk/v1/flags").set("Authorization", `Bearer ${key}`);

  it("limits each API key separately", async () => {
    const app = makeApp({ limits: { ...noLimits, sdkFlags: rule(3, 60_000) } });
    const { devKey, prodKey } = await setup(app);
    for (let i = 0; i < 3; i++) expect((await flags(app, devKey)).status).toBe(200);
    const blocked = await flags(app, devKey);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect((await flags(app, prodKey)).status).toBe(200); // another key is unaffected
  });

  it("limits evaluate calls and new stream connections per key", async () => {
    const app = makeApp({ limits: { ...noLimits, sdkEvaluate: rule(2, 60_000), sdkStream: rule(1, 60_000) } });
    const { devKey } = await setup(app);
    const evaluate = () => request(app).post("/sdk/v1/evaluate").set("Authorization", `Bearer ${devKey}`).send({ flagKey: "f-one", context: { key: "u1" } });
    expect((await evaluate()).status).toBe(200);
    expect((await evaluate()).status).toBe(200);
    expect((await evaluate()).status).toBe(429);
    const all = await request(app).post("/sdk/v1/evaluate-all").set("Authorization", `Bearer ${devKey}`).send({ context: { key: "u1" } });
    expect(all.status).toBe(429); // evaluate and evaluate-all share one budget
  });

  it("stops unauthenticated floods before they reach the database", async () => {
    const app = makeApp({ limits: { ...noLimits, sdkPerIp: rule(5, 60_000) } });
    const spy = vi.spyOn(prisma.apiKey, "findUnique");
    try {
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push((await flags(app, `ff_guess_${i}_aaaaaaaaaaaaaaaa`)).status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(7);
      expect(spy).toHaveBeenCalledTimes(5); // the 7 blocked requests never touched Postgres
    } finally {
      spy.mockRestore();
    }
  });
});
