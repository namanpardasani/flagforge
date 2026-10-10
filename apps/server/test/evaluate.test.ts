import { evaluateFlag, type FlagConfig } from "@flagforge/core";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { makeApp, registerUser, resetDb, type TestUser } from "./helpers.js";

const app = makeApp();

let owner: TestUser;
let outsider: TestUser;
let wsId: string;
let projectId: string;
let flagId: string;
let devId: string;
let prodId: string;
let devKey: string;
let prodKey: string;

const post = (u: TestUser, url: string, body: object = {}) => request(app).post(url).set("Authorization", u.auth).send(body);
const put = (u: TestUser, url: string, body: object) => request(app).put(url).set("Authorization", u.auth).send(body);
const evaluate = (key: string | undefined, body: object) => {
  const r = request(app).post("/sdk/v1/evaluate");
  return (key ? r.set("Authorization", `Bearer ${key}`) : r).send(body);
};
const evaluateAll = (key: string, body: object) => request(app).post("/sdk/v1/evaluate-all").set("Authorization", `Bearer ${key}`).send(body);
const configure = (env: string, body: object, flag = flagId) =>
  put(owner, `/workspaces/${wsId}/projects/${projectId}/flags/${flag}/environments/${env}`, body);
const rule = (attribute: string, operator: string, value: unknown, rolloutPercentage = 100) => ({
  conditions: [{ attribute, operator, value }],
  rolloutPercentage,
});

async function setup(user: TestUser, slug: string) {
  const ws = (await post(user, "/workspaces", { name: slug, slug })).body.id as string;
  const project = (await post(user, `/workspaces/${ws}/projects`, { name: "Project", key: "proj" })).body;
  const env = (key: string) => project.environments.find((e: { key: string }) => e.key === key).id as string;
  const flag = (await post(user, `/workspaces/${ws}/projects/${project.id}/flags`, { key: "checkout", name: "Checkout" })).body.id as string;
  const mk = async (envId: string) =>
    (await post(user, `/workspaces/${ws}/projects/${project.id}/environments/${envId}/api-keys`, { name: "k" })).body.key as string;
  return { ws, projectId: project.id as string, flag, devId: env("dev"), prodId: env("prod"), devKey: await mk(env("dev")), prodKey: await mk(env("prod")) };
}

beforeEach(async () => {
  await resetDb();
  [owner, outsider] = (await Promise.all(["owner", "outsider"].map((n) => registerUser(app, `${n}@example.com`)))) as [TestUser, TestUser];
  ({ ws: wsId, projectId, flag: flagId, devId, prodId, devKey, prodKey } = await setup(owner, "acme"));
});

describe("POST /sdk/v1/evaluate", () => {
  it("returns false with reason OFF until the flag is enabled", async () => {
    const res = await evaluate(devKey, { flagKey: "checkout", context: { key: "u1" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flagKey: "checkout", value: false, reason: "OFF" });
  });

  it("returns true via the fallthrough once enabled at 100%", async () => {
    await configure(devId, { enabled: true });
    const res = await evaluate(devKey, { flagKey: "checkout", context: { key: "u1" } });
    expect(res.body).toEqual({ flagKey: "checkout", value: true, reason: "FALLTHROUGH" });
  });

  it("evaluates each environment independently, using the key's own environment", async () => {
    await configure(devId, { enabled: true });
    expect((await evaluate(devKey, { flagKey: "checkout", context: { key: "u1" } })).body.value).toBe(true);
    expect((await evaluate(prodKey, { flagKey: "checkout", context: { key: "u1" } })).body.value).toBe(false);
  });

  it("matches rules on attributes and reports the rule id", async () => {
    await configure(devId, { enabled: true, rolloutPercentage: 0, rules: [{ id: "pro-users", ...rule("plan", "equals", "pro") }] });
    const pro = await evaluate(devKey, { flagKey: "checkout", context: { key: "u1", attributes: { plan: "pro" } } });
    expect(pro.body).toEqual({ flagKey: "checkout", value: true, reason: "RULE_MATCH", ruleId: "pro-users" });
    const free = await evaluate(devKey, { flagKey: "checkout", context: { key: "u1", attributes: { plan: "free" } } });
    expect(free.body).toMatchObject({ value: false, reason: "FALLTHROUGH" });
    const none = await evaluate(devKey, { flagKey: "checkout", context: { key: "u1" } });
    expect(none.body).toMatchObject({ value: false, reason: "FALLTHROUGH" });
  });

  it("does not let a missing attribute satisfy a negative rule", async () => {
    await configure(devId, { enabled: true, rolloutPercentage: 0, rules: [rule("plan", "not_equals", "free")] });
    const missing = await evaluate(devKey, { flagKey: "checkout", context: { key: "u1" } });
    expect(missing.body.reason).toBe("FALLTHROUGH");
    const pro = await evaluate(devKey, { flagKey: "checkout", context: { key: "u1", attributes: { plan: "pro" } } });
    expect(pro.body.reason).toBe("RULE_MATCH");
  });

  it("gives a user the same answer every time", async () => {
    await configure(devId, { enabled: true, rolloutPercentage: 50 });
    for (const user of ["alice", "bob", "carol", "dave"]) {
      const first = (await evaluate(devKey, { flagKey: "checkout", context: { key: user } })).body;
      for (let i = 0; i < 3; i++) expect((await evaluate(devKey, { flagKey: "checkout", context: { key: user } })).body).toEqual(first);
    }
  });

  it("agrees with evaluating locally using the config the SDK downloads (server and SDK cannot drift)", async () => {
    await configure(devId, {
      enabled: true,
      rolloutPercentage: 30,
      rules: [rule("country", "in", ["US", "CA"], 60), rule("age", "gte", 65, 100)],
    });
    const download = await request(app).get("/sdk/v1/flags").set("Authorization", `Bearer ${devKey}`);
    const config = download.body.flags.find((f: FlagConfig) => f.key === "checkout") as FlagConfig;
    const countries = ["US", "CA", "DE", undefined];
    for (let i = 0; i < 60; i++) {
      const context = { key: `user-${i}`, attributes: { country: countries[i % 4], age: 20 + (i % 50) } as Record<string, any> };
      const remote = (await evaluate(devKey, { flagKey: "checkout", context })).body;
      const { flagKey: _f, ...remoteResult } = remote;
      expect(remoteResult).toEqual(evaluateFlag(config, context));
    }
  });

  it("applies a rollout to roughly the requested share of users", async () => {
    await configure(devId, { enabled: true, rolloutPercentage: 50 });
    let on = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      if ((await evaluate(devKey, { flagKey: "checkout", context: { key: `person-${i}` } })).body.value) on++;
    }
    expect(on / n).toBeGreaterThan(0.38);
    expect(on / n).toBeLessThan(0.62);
  });

  it("only adds users when the rollout grows (never flips anyone off)", async () => {
    const usersOn = async () => {
      const out = new Set<string>();
      for (let i = 0; i < 80; i++) {
        if ((await evaluate(devKey, { flagKey: "checkout", context: { key: `p${i}` } })).body.value) out.add(`p${i}`);
      }
      return out;
    };
    await configure(devId, { enabled: true, rolloutPercentage: 20 });
    const small = await usersOn();
    await configure(devId, { rolloutPercentage: 60 });
    const large = await usersOn();
    for (const u of small) expect(large.has(u)).toBe(true);
    expect(large.size).toBeGreaterThan(small.size);
  });

  it("returns 404 for an unknown flag", async () => {
    const res = await evaluate(devKey, { flagKey: "nope", context: { key: "u1" } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("FLAG_NOT_FOUND");
  });
});

describe("POST /sdk/v1/evaluate-all", () => {
  it("evaluates every flag of the project for the key's environment", async () => {
    const second = (await post(owner, `/workspaces/${wsId}/projects/${projectId}/flags`, { key: "dark-mode", name: "Dark" })).body.id;
    await configure(devId, { enabled: true });
    await configure(devId, { enabled: true, rolloutPercentage: 0 }, second);
    const res = await evaluateAll(devKey, { context: { key: "u1" } });
    expect(res.status).toBe(200);
    expect(res.body.flags).toEqual({
      checkout: { value: true, reason: "FALLTHROUGH" },
      "dark-mode": { value: false, reason: "FALLTHROUGH" },
    });
    expect((await evaluateAll(prodKey, { context: { key: "u1" } })).body.flags.checkout).toEqual({ value: false, reason: "OFF" });
  });
});

describe("validation", () => {
  it("rejects malformed requests with 400", async () => {
    const bad: object[] = [
      {},
      { flagKey: "checkout" },
      { context: { key: "u1" } },
      { flagKey: "", context: { key: "u1" } },
      { flagKey: "checkout", context: {} },
      { flagKey: "checkout", context: { key: "" } },
      { flagKey: "checkout", context: { key: "x".repeat(257) } },
      { flagKey: "checkout", context: { key: 123 } },
      { flagKey: "checkout", context: { key: "u", attributes: { nested: { a: 1 } } } },
      { flagKey: "checkout", context: { key: "u", attributes: { list: [1, 2] } } },
      { flagKey: "checkout", context: { key: "u", attributes: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, "x"])) } },
    ];
    for (const body of bad) {
      const res = await evaluate(devKey, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  it("accepts every supported attribute type", async () => {
    const res = await evaluate(devKey, {
      flagKey: "checkout",
      context: { key: "u1", attributes: { s: "x", n: 1.5, b: false, tags: ["a", "b"] } },
    });
    expect(res.status).toBe(200);
  });

  it("survives hostile attribute names without a server error", async () => {
    await configure(devId, { enabled: true, rolloutPercentage: 0, rules: [rule("constructor", "not_equals", "x")] });
    const raw = '{"flagKey":"checkout","context":{"key":"u1","attributes":{"__proto__":"x","constructor":"y","toString":"z"}}}';
    const res = await request(app).post("/sdk/v1/evaluate").set("Authorization", `Bearer ${devKey}`).set("Content-Type", "application/json").send(raw);
    expect(res.status).toBeLessThan(500);
    const noAttrs = await evaluate(devKey, { flagKey: "checkout", context: { key: "u1" } });
    expect(noAttrs.body.reason).toBe("FALLTHROUGH"); // inherited "constructor" did not match
  });
});

describe("authentication and tenant isolation", () => {
  it("requires a valid API key", async () => {
    for (const key of [undefined, "garbage", owner.auth.replace("Bearer ", "")]) {
      expect((await evaluate(key, { flagKey: "checkout", context: { key: "u1" } })).status).toBe(401);
    }
    expect((await evaluateAll("garbage", { context: { key: "u1" } })).status).toBe(401);
  });

  it("stops evaluating when the key is revoked", async () => {
    const keys = (await request(app).get(`/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys`).set("Authorization", owner.auth)).body.apiKeys;
    await request(app).delete(`/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys/${keys[0].id}`).set("Authorization", owner.auth);
    expect((await evaluate(devKey, { flagKey: "checkout", context: { key: "u1" } })).status).toBe(401);
  });

  it("each tenant sees only its own flag, even when keys and flag names are identical", async () => {
    const theirs = await setup(outsider, "other-co");
    await configure(devId, { enabled: true });
    await put(outsider, `/workspaces/${theirs.ws}/projects/${theirs.projectId}/flags/${theirs.flag}/environments/${theirs.devId}`, { enabled: true, rolloutPercentage: 0 });
    // Same flag key "checkout" in both tenants, but different answers.
    expect((await evaluate(devKey, { flagKey: "checkout", context: { key: "u1" } })).body.value).toBe(true);
    expect((await evaluate(theirs.devKey, { flagKey: "checkout", context: { key: "u1" } })).body.value).toBe(false);
  });

  it("cannot reach another tenant's flags by naming them", async () => {
    const theirs = await setup(outsider, "other-co");
    await post(outsider, `/workspaces/${theirs.ws}/projects/${theirs.projectId}/flags`, { key: "secret-flag", name: "S" });
    const res = await evaluate(devKey, { flagKey: "secret-flag", context: { key: "u1" } });
    expect(res.status).toBe(404);
    expect(JSON.stringify((await evaluateAll(devKey, { context: { key: "u1" } })).body)).not.toContain("secret-flag");
    expect(prodId).toBeTruthy();
  });
});
