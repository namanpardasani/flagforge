import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/auth/tokens.js";
import { makeApp, prisma, registerUser, resetDb, type TestUser } from "./helpers.js";

const app = makeApp();

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let wsId: string;
let otherWsId: string;
let projectId: string;
let devId: string;
let prodId: string;
let otherProjectId: string;
let otherEnvId: string;

const post = (u: TestUser, url: string, body: object = {}) => request(app).post(url).set("Authorization", u.auth).send(body);
const get = (u: TestUser, url: string) => request(app).get(url).set("Authorization", u.auth);
const put = (u: TestUser, url: string, body: object) => request(app).put(url).set("Authorization", u.auth).send(body);
const del = (u: TestUser, url: string) => request(app).delete(url).set("Authorization", u.auth);
const keysUrl = (ws: string, p: string, e: string) => `/workspaces/${ws}/projects/${p}/environments/${e}/api-keys`;
const sdkFlags = (key?: string) => {
  const r = request(app).get("/sdk/v1/flags");
  return key ? r.set("Authorization", `Bearer ${key}`) : r;
};
const createKey = (u: TestUser, env = devId, name = "backend", ws = wsId, p = projectId) =>
  post(u, keysUrl(ws, p, env), { name });

beforeEach(async () => {
  await resetDb();
  [owner, admin, member, viewer, outsider] = (await Promise.all(
    ["owner", "admin", "member", "viewer", "outsider"].map((n) => registerUser(app, `${n}@example.com`)),
  )) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  wsId = (await post(owner, "/workspaces", { name: "Acme", slug: "acme" })).body.id;
  otherWsId = (await post(outsider, "/workspaces", { name: "Other", slug: "other-co" })).body.id;
  for (const [u, role] of [[admin, "ADMIN"], [member, "MEMBER"], [viewer, "VIEWER"]] as const) {
    await post(owner, `/workspaces/${wsId}/members`, { email: u.email, role });
  }
  const project = (await post(owner, `/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = project.id;
  devId = project.environments.find((e: { key: string }) => e.key === "dev").id;
  prodId = project.environments.find((e: { key: string }) => e.key === "prod").id;
  const other = (await post(outsider, `/workspaces/${otherWsId}/projects`, { name: "Secret", key: "secret" })).body;
  otherProjectId = other.id;
  otherEnvId = other.environments[0].id;
});

describe("creating and listing API keys", () => {
  it("returns the full key once and stores only its hash", async () => {
    const res = await createKey(admin);
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^ff_[A-Za-z0-9_-]{32}$/);
    expect(res.body.prefix).toBe(res.body.key.slice(0, 10));
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.keyHash).toBe(hashToken(res.body.key));
    expect(JSON.stringify(row)).not.toContain(res.body.key);
    expect(row).toMatchObject({ workspaceId: wsId, environmentId: devId, createdById: admin.id, revokedAt: null });
  });

  it("generates a different key every time", async () => {
    const keys = new Set([(await createKey(owner)).body.key, (await createKey(owner)).body.key]);
    expect(keys.size).toBe(2);
  });

  it("never returns the key or hash when listing", async () => {
    const created = (await createKey(owner)).body;
    const list = await get(owner, keysUrl(wsId, projectId, devId));
    expect(list.status).toBe(200);
    expect(list.body.apiKeys).toHaveLength(1);
    expect(list.body.apiKeys[0]).toMatchObject({ id: created.id, name: "backend", prefix: created.prefix });
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(created.key);
    expect(text).not.toMatch(/keyHash/);
  });

  it("validates the name", async () => {
    for (const body of [{}, { name: "" }, { name: "x".repeat(101) }]) {
      expect((await post(owner, keysUrl(wsId, projectId, devId), body)).status).toBe(400);
    }
  });
});

describe("permissions", () => {
  it("requires authentication", async () => {
    expect((await request(app).get(keysUrl(wsId, projectId, devId))).status).toBe(401);
  });

  it("allows only OWNER and ADMIN to create, list and revoke", async () => {
    const key = (await createKey(owner)).body;
    for (const u of [member, viewer]) {
      expect((await createKey(u)).status).toBe(403);
      expect((await get(u, keysUrl(wsId, projectId, devId))).status).toBe(403);
      expect((await del(u, `${keysUrl(wsId, projectId, devId)}/${key.id}`)).status).toBe(403);
    }
    expect(await prisma.apiKey.count()).toBe(1);
    expect((await get(admin, keysUrl(wsId, projectId, devId))).status).toBe(200);
  });
});

describe("tenant isolation", () => {
  it("hides the workspace from non-members (404) and creates nothing", async () => {
    const key = (await createKey(owner)).body;
    const results = await Promise.all([
      createKey(outsider),
      get(outsider, keysUrl(wsId, projectId, devId)),
      del(outsider, `${keysUrl(wsId, projectId, devId)}/${key.id}`),
    ]);
    for (const res of results) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("WORKSPACE_NOT_FOUND");
    }
    expect(await prisma.apiKey.count()).toBe(1);
  });

  it("rejects environments from another tenant or another project", async () => {
    const foreign = await createKey(owner, otherEnvId);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("ENVIRONMENT_NOT_FOUND");
    expect((await createKey(owner, otherEnvId, "x", wsId, otherProjectId)).status).toBe(404);
    expect((await get(owner, keysUrl(wsId, projectId, otherEnvId))).status).toBe(404);
    expect(await prisma.apiKey.count()).toBe(0);
  });

  it("cannot revoke another tenant's key through your own environment path", async () => {
    const victim = (await createKey(outsider, otherEnvId, "secret", otherWsId, otherProjectId)).body;
    const viaOwnEnv = await del(owner, `${keysUrl(wsId, projectId, devId)}/${victim.id}`);
    expect(viaOwnEnv.status).toBe(404);
    expect(viaOwnEnv.body.error.code).toBe("API_KEY_NOT_FOUND");
    expect((await sdkFlags(victim.key)).status).toBe(200);
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: victim.id } })).revokedAt).toBeNull();
  });
});

describe("revoking", () => {
  it("stops the key working immediately, and a second revoke is a 404", async () => {
    const key = (await createKey(owner)).body;
    expect((await sdkFlags(key.key)).status).toBe(200);
    const url = `${keysUrl(wsId, projectId, devId)}/${key.id}`;
    expect((await del(admin, url)).status).toBe(204);
    const after = await sdkFlags(key.key);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("INVALID_API_KEY");
    expect((await del(admin, url)).status).toBe(404);
    const list = await get(owner, keysUrl(wsId, projectId, devId));
    expect(list.body.apiKeys[0].revokedAt).not.toBeNull();
  });

  it("stops working when its environment is deleted", async () => {
    const key = (await createKey(owner, prodId)).body;
    await del(owner, `/workspaces/${wsId}/projects/${projectId}/environments/${prodId}`);
    expect((await sdkFlags(key.key)).status).toBe(401);
  });
});

describe("audit trail", () => {
  it("records creation and revocation without the secret", async () => {
    const key = (await createKey(admin)).body;
    await del(admin, `${keysUrl(wsId, projectId, devId)}/${key.id}`);
    const entries = (await get(owner, `/workspaces/${wsId}/audit-log`)).body.entries;
    expect(entries.map((e: { action: string }) => e.action).slice(0, 2)).toEqual(["apikey.revoked", "apikey.created"]);
    expect(entries[1].metadata).toMatchObject({ name: "backend", prefix: key.prefix, environmentKey: "dev" });
    expect(entries[1].actor.id).toBe(admin.id);
    expect(JSON.stringify(entries)).not.toContain(key.key);
  });
});

describe("GET /sdk/v1/flags", () => {
  async function flag(key: string, ws = wsId, p = projectId, as = owner) {
    return (await post(as, `/workspaces/${ws}/projects/${p}/flags`, { key, name: key })).body;
  }
  const toggle = (f: { id: string }, env: string, enabled: boolean) =>
    put(owner, `/workspaces/${wsId}/projects/${projectId}/flags/${f.id}/environments/${env}`, { enabled });

  it("returns the flags as seen by the key's own environment", async () => {
    const a = await flag("alpha");
    await flag("beta");
    await toggle(a, devId, true);
    await toggle(a, prodId, false);
    const devKey = (await createKey(owner, devId)).body.key;
    const prodKey = (await createKey(owner, prodId)).body.key;
    const dev = await sdkFlags(devKey);
    expect(dev.status).toBe(200);
    expect(dev.body.environment).toMatchObject({ id: devId, key: "dev" });
    const off = { rules: [], fallthroughBps: 10000 };
    expect(dev.body.flags).toEqual([{ key: "alpha", enabled: true, ...off }, { key: "beta", enabled: false, ...off }]);
    expect((await sdkFlags(prodKey)).body.flags).toEqual([
      { key: "alpha", enabled: false, ...off },
      { key: "beta", enabled: false, ...off },
    ]);
  });

  it("never exposes another tenant's flags", async () => {
    await flag("mine");
    await flag("theirs-only", otherWsId, otherProjectId, outsider);
    const theirKey = (await createKey(outsider, otherEnvId, "k", otherWsId, otherProjectId)).body.key;
    const res = await sdkFlags(theirKey);
    expect(res.body.flags).toEqual([{ key: "theirs-only", enabled: false, rules: [], fallthroughBps: 10000 }]);
    const myKey = (await createKey(owner)).body.key;
    expect(JSON.stringify((await sdkFlags(myKey)).body)).not.toContain("theirs-only");
  });

  it("rejects missing, malformed, unknown and user-JWT credentials with 401", async () => {
    const real = (await createKey(owner)).body.key;
    const tampered = real.slice(0, -1) + (real.endsWith("a") ? "b" : "a");
    for (const key of [undefined, "garbage", "ff_unknown", tampered, owner.auth.replace("Bearer ", "")]) {
      const res = await sdkFlags(key);
      expect(res.status, String(key)).toBe(401);
      expect(res.body.error.code).toBe("INVALID_API_KEY");
    }
  });

  it("does not accept an API key on user endpoints", async () => {
    const key = (await createKey(owner)).body.key;
    const res = await request(app).get("/workspaces").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(401);
  });
});
