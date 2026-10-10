import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { makeApp, prisma, registerUser, resetDb, type TestUser } from "./helpers.js";

const app = makeApp();

let owner: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let wsId: string;
let otherWsId: string;
let projectId: string;
let devId: string;
let prodId: string;
let flagId: string;
let otherFlagId: string;
let otherEnvId: string;
let otherProjectId: string;

const post = (u: TestUser, url: string, body: object = {}) => request(app).post(url).set("Authorization", u.auth).send(body);
const get = (u: TestUser, url: string) => request(app).get(url).set("Authorization", u.auth);
const put = (u: TestUser, url: string, body: object) => request(app).put(url).set("Authorization", u.auth).send(body);
const stateUrl = (env: string, flag = flagId, ws = wsId, p = projectId) =>
  `/workspaces/${ws}/projects/${p}/flags/${flag}/environments/${env}`;
const setState = (u: TestUser, env: string, body: object) => put(u, stateUrl(env), body);

const proRule = { description: "Pro users", conditions: [{ attribute: "plan", operator: "equals", value: "pro" }], rolloutPercentage: 50 };

beforeEach(async () => {
  await resetDb();
  [owner, member, viewer, outsider] = (await Promise.all(
    ["owner", "member", "viewer", "outsider"].map((n) => registerUser(app, `${n}@example.com`)),
  )) as [TestUser, TestUser, TestUser, TestUser];
  wsId = (await post(owner, "/workspaces", { name: "Acme", slug: "acme" })).body.id;
  otherWsId = (await post(outsider, "/workspaces", { name: "Other", slug: "other-co" })).body.id;
  await post(owner, `/workspaces/${wsId}/members`, { email: member.email, role: "MEMBER" });
  await post(owner, `/workspaces/${wsId}/members`, { email: viewer.email, role: "VIEWER" });
  const project = (await post(owner, `/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = project.id;
  devId = project.environments.find((e: { key: string }) => e.key === "dev").id;
  prodId = project.environments.find((e: { key: string }) => e.key === "prod").id;
  flagId = (await post(owner, `/workspaces/${wsId}/projects/${projectId}/flags`, { key: "new-checkout", name: "New checkout" })).body.id;
  const other = (await post(outsider, `/workspaces/${otherWsId}/projects`, { name: "Secret", key: "secret" })).body;
  otherProjectId = other.id;
  otherEnvId = other.environments[0].id;
  otherFlagId = (await post(outsider, `/workspaces/${otherWsId}/projects/${otherProjectId}/flags`, { key: "secret-flag", name: "S" })).body.id;
});

const envState = (body: any, key: string) => body.environments.find((e: { key: string }) => e.key === key);

describe("setting rules and rollout", () => {
  it("defaults to off, no rules, 100% fallthrough", async () => {
    const flag = (await get(owner, `/workspaces/${wsId}/projects/${projectId}/flags/${flagId}`)).body;
    expect(envState(flag, "dev")).toMatchObject({ enabled: false, rules: [], rolloutPercentage: 100 });
  });

  it("stores rules (generating ids) and a fallthrough percentage in one call", async () => {
    const res = await setState(member, devId, { enabled: true, rules: [proRule], rolloutPercentage: 12.5 });
    expect(res.status).toBe(200);
    const dev = envState(res.body, "dev");
    expect(dev.enabled).toBe(true);
    expect(dev.rolloutPercentage).toBe(12.5);
    expect(dev.rules).toHaveLength(1);
    expect(dev.rules[0]).toMatchObject({ description: "Pro users", rolloutPercentage: 50, conditions: proRule.conditions });
    expect(dev.rules[0].id).toMatch(/^[0-9a-f-]{36}$/);
    const row = await prisma.flagState.findUniqueOrThrow({ where: { flagId_environmentId: { flagId, environmentId: devId } } });
    expect(row.fallthroughBps).toBe(1250);
    expect((row.rules as any)[0].rolloutBps).toBe(5000);
    // other environments untouched
    expect(envState(res.body, "prod")).toMatchObject({ enabled: false, rules: [], rolloutPercentage: 100 });
  });

  it("keeps fields you do not send (partial updates)", async () => {
    await setState(member, devId, { enabled: true, rules: [proRule], rolloutPercentage: 20 });
    const res = await setState(member, devId, { enabled: false });
    const dev = envState(res.body, "dev");
    expect(dev).toMatchObject({ enabled: false, rolloutPercentage: 20 });
    expect(dev.rules).toHaveLength(1);
    const cleared = await setState(member, devId, { rules: [] });
    expect(envState(cleared.body, "dev").rules).toEqual([]);
  });

  it("keeps a caller-supplied rule id, and rejects duplicate ids", async () => {
    const res = await setState(member, devId, { rules: [{ ...proRule, id: "pro-users" }] });
    expect(envState(res.body, "dev").rules[0].id).toBe("pro-users");
    const dup = await setState(member, devId, { rules: [{ ...proRule, id: "same" }, { ...proRule, id: "same" }] });
    expect(dup.status).toBe(400);
  });

  it("defaults a rule's rollout to 100%", async () => {
    const { rolloutPercentage: _omit, ...noRollout } = proRule;
    const res = await setState(member, devId, { rules: [noRollout] });
    expect(envState(res.body, "dev").rules[0].rolloutPercentage).toBe(100);
  });
});

describe("validation", () => {
  const bad: [string, object][] = [
    ["empty body", {}],
    ["unknown field", { enabled: true, extra: 1 }],
    ["string enabled", { enabled: "true" }],
    ["percentage above 100", { rolloutPercentage: 100.01 }],
    ["negative percentage", { rolloutPercentage: -1 }],
    ["three decimals", { rolloutPercentage: 12.345 }],
    ["rule percentage out of range", { rules: [{ ...proRule, rolloutPercentage: 101 }] }],
    ["rule without conditions", { rules: [{ rolloutPercentage: 50, conditions: [] }] }],
    ["too many conditions", { rules: [{ conditions: Array(11).fill(proRule.conditions[0]) }] }],
    ["too many rules", { rules: Array(21).fill(proRule) }],
    ["unknown operator", { rules: [{ conditions: [{ attribute: "a", operator: "regex", value: "x" }] }] }],
    ["in without a list", { rules: [{ conditions: [{ attribute: "a", operator: "in", value: "x" }] }] }],
    ["equals with a list", { rules: [{ conditions: [{ attribute: "a", operator: "equals", value: ["x"] }] }] }],
    ["gt with a string", { rules: [{ conditions: [{ attribute: "a", operator: "gt", value: "5" }] }] }],
    ["contains with a number", { rules: [{ conditions: [{ attribute: "a", operator: "contains", value: 5 }] }] }],
    ["empty list", { rules: [{ conditions: [{ attribute: "a", operator: "in", value: [] }] }] }],
    ["empty attribute", { rules: [{ conditions: [{ attribute: "", operator: "equals", value: "x" }] }] }],
    ["bad rule id", { rules: [{ ...proRule, id: "has space" }] }],
  ];
  for (const [name, body] of bad) {
    it(`rejects: ${name}`, async () => {
      const res = await setState(member, devId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  }

  it("accepts the boundary values 0 and 100", async () => {
    expect((await setState(member, devId, { rolloutPercentage: 0 })).status).toBe(200);
    expect((await setState(member, devId, { rolloutPercentage: 100 })).status).toBe(200);
    expect((await setState(member, devId, { rolloutPercentage: 0.01 })).status).toBe(200);
  });

  it("changes nothing in the database when validation fails", async () => {
    await setState(member, devId, { rules: [{ conditions: [{ attribute: "a", operator: "gt", value: "x" }] }] });
    expect(await prisma.flagState.count()).toBe(0);
  });
});

describe("audit trail", () => {
  it("logs targeting changes with before and after, separately from toggles", async () => {
    await setState(member, devId, { enabled: true, rules: [proRule], rolloutPercentage: 25 });
    const entries = (await get(owner, `/workspaces/${wsId}/audit-log`)).body.entries;
    const actions = entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("flag.toggled");
    expect(actions).toContain("flag.targeting_updated");
    const targeting = entries.find((e: { action: string }) => e.action === "flag.targeting_updated");
    expect(targeting.metadata.before).toEqual({ rules: [], fallthroughBps: 10000 });
    expect(targeting.metadata.after.fallthroughBps).toBe(2500);
    expect(targeting.metadata.after.rules).toHaveLength(1);
    expect(targeting.metadata).toMatchObject({ key: "new-checkout", environmentKey: "dev" });
    expect(targeting.actor.id).toBe(member.id);
  });

  it("logs nothing when an update changes nothing", async () => {
    await setState(member, devId, { enabled: true, rolloutPercentage: 40 });
    const count = () => prisma.auditLog.count({ where: { workspaceId: wsId } });
    const before = await count();
    await setState(member, devId, { enabled: true, rolloutPercentage: 40 });
    expect(await count()).toBe(before);
  });
});

describe("permissions and isolation", () => {
  it("allows MEMBER and OWNER but not VIEWER to change targeting", async () => {
    expect((await setState(viewer, devId, { rolloutPercentage: 10 })).status).toBe(403);
    expect(await prisma.flagState.count()).toBe(0);
    expect((await setState(member, devId, { rolloutPercentage: 10 })).status).toBe(200);
    expect((await setState(owner, devId, { rolloutPercentage: 20 })).status).toBe(200);
  });

  it("returns 404 for a non-member and changes nothing", async () => {
    const res = await setState(outsider, devId, { enabled: true, rolloutPercentage: 1, rules: [proRule] });
    expect(res.status).toBe(404);
    expect(await prisma.flagState.count()).toBe(0);
  });

  it("cannot set targeting on another tenant's flag or environment", async () => {
    expect((await put(owner, stateUrl(devId, otherFlagId), { enabled: true })).status).toBe(404);
    const foreignEnv = await put(owner, stateUrl(otherEnvId), { enabled: true });
    expect(foreignEnv.status).toBe(404);
    expect(foreignEnv.body.error.code).toBe("ENVIRONMENT_NOT_FOUND");
    expect(await prisma.flagState.count()).toBe(0);
  });

  it("never leaks another tenant's rules through the flag listing", async () => {
    await put(outsider, stateUrl(otherEnvId, otherFlagId, otherWsId, otherProjectId), {
      enabled: true,
      rules: [{ conditions: [{ attribute: "secret-attr", operator: "equals", value: "x" }] }],
    });
    const mine = await get(owner, `/workspaces/${wsId}/projects/${projectId}/flags`);
    expect(JSON.stringify(mine.body)).not.toContain("secret-attr");
    expect(prodId).toBeTruthy();
  });
});
