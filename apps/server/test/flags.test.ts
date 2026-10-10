import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
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

const flagsUrl = (ws: string, p: string) => `/workspaces/${ws}/projects/${p}/flags`;
const post = (u: TestUser, url: string, body: object = {}) => request(app).post(url).set("Authorization", u.auth).send(body);
const get = (u: TestUser, url: string) => request(app).get(url).set("Authorization", u.auth);
const patch = (u: TestUser, url: string, body: object) => request(app).patch(url).set("Authorization", u.auth).send(body);
const put = (u: TestUser, url: string, body: object) => request(app).put(url).set("Authorization", u.auth).send(body);
const del = (u: TestUser, url: string) => request(app).delete(url).set("Authorization", u.auth);

const createFlag = (u: TestUser, body: object = { key: "new-checkout", name: "New checkout" }, ws = wsId, p = projectId) =>
  post(u, flagsUrl(ws, p), body);
const toggle = (u: TestUser, flagId: string, envId: string, enabled: unknown, ws = wsId, p = projectId) =>
  put(u, `${flagsUrl(ws, p)}/${flagId}/environments/${envId}`, { enabled });
const auditRows = (workspaceId: string) => prisma.auditLog.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });

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
  // Creating a project also creates its dev, staging and prod environments.
  const project = (await post(owner, `/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = project.id;
  devId = project.environments.find((e: { key: string }) => e.key === "dev").id;
  prodId = project.environments.find((e: { key: string }) => e.key === "prod").id;
  const other = (await post(outsider, `/workspaces/${otherWsId}/projects`, { name: "Secret", key: "secret" })).body;
  otherProjectId = other.id;
  otherEnvId = other.environments[0].id;
});

describe("creating and reading flags", () => {
  it("creates a flag that is off in every environment", async () => {
    const res = await createFlag(member, { key: "New-Checkout", name: "New checkout", description: "redesign" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: "new-checkout", name: "New checkout", description: "redesign" });
    expect(res.body.environments).toMatchObject([
      { environmentId: devId, key: "dev", enabled: false },
      { key: "staging", enabled: false },
      { environmentId: prodId, key: "prod", enabled: false },
    ]);
  });

  it("rejects duplicate keys per project with 409, allows the same key in another project", async () => {
    await createFlag(owner);
    const dup = await createFlag(owner);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("FLAG_KEY_TAKEN");
    const other = (await post(owner, `/workspaces/${wsId}/projects`, { name: "Mobile", key: "mobile" })).body.id;
    expect((await createFlag(owner, { key: "new-checkout", name: "x" }, wsId, other)).status).toBe(201);
  });

  it("validates input", async () => {
    for (const body of [{}, { key: "x", name: "n" }, { key: "Bad Key!", name: "n" }, { key: "ok-key", name: "" }, { key: "ok-key", name: "n", description: "d".repeat(501) }]) {
      expect((await createFlag(owner, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("lists flags with per-environment state, including environments created later", async () => {
    const flag = (await createFlag(owner)).body;
    await toggle(owner, flag.id, devId, true);
    const qa = (await post(owner, `/workspaces/${wsId}/projects/${projectId}/environments`, { name: "QA", key: "qa" })).body;
    const list = await get(viewer, flagsUrl(wsId, projectId));
    expect(list.status).toBe(200);
    const states = Object.fromEntries(list.body.flags[0].environments.map((e: { key: string; enabled: boolean }) => [e.key, e.enabled]));
    expect(states).toEqual({ dev: true, staging: false, prod: false, qa: false });
    expect(list.body.flags[0].environments.some((e: { environmentId: string }) => e.environmentId === qa.id)).toBe(true);
  });

  it("gets, updates and clears the description of a flag", async () => {
    const flag = (await createFlag(owner, { key: "f-one", name: "One", description: "d" })).body;
    const url = `${flagsUrl(wsId, projectId)}/${flag.id}`;
    expect((await get(viewer, url)).body.name).toBe("One");
    const updated = await patch(member, url, { name: "Renamed", description: null });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: "Renamed", description: null, key: "f-one" });
    expect((await patch(member, url, {})).status).toBe(400);
    expect((await patch(member, url, { key: "cannot-change" })).status).toBe(400);
  });
});

describe("toggling", () => {
  it("turns a flag on in one environment only", async () => {
    const flag = (await createFlag(member)).body;
    const res = await toggle(member, flag.id, prodId, true);
    expect(res.status).toBe(200);
    const states = Object.fromEntries(res.body.environments.map((e: { key: string; enabled: boolean }) => [e.key, e.enabled]));
    expect(states).toEqual({ dev: false, staging: false, prod: true });
  });

  it("requires a real boolean", async () => {
    const flag = (await createFlag(member)).body;
    for (const enabled of ["true", 1, null, undefined]) {
      expect((await toggle(member, flag.id, devId, enabled)).status, String(enabled)).toBe(400);
    }
  });

  it("writes an audit entry only when the value actually changes", async () => {
    const flag = (await createFlag(member)).body;
    await toggle(member, flag.id, devId, false); // already off: no change
    await toggle(member, flag.id, devId, true);
    await toggle(member, flag.id, devId, true); // already on: no change
    await toggle(member, flag.id, devId, false);
    const actions = (await auditRows(wsId)).filter((r) => r.action === "flag.toggled");
    expect(actions).toHaveLength(2);
    expect(actions[0]!.metadata).toMatchObject({ key: "new-checkout", environmentKey: "dev", from: false, to: true });
    expect(actions[1]!.metadata).toMatchObject({ from: true, to: false });
    expect(actions[0]!.actorId).toBe(member.id);
  });

  it("cascades: deleting an environment removes its flag state", async () => {
    const flag = (await createFlag(owner)).body;
    await toggle(owner, flag.id, devId, true);
    await del(owner, `/workspaces/${wsId}/projects/${projectId}/environments/${devId}`);
    expect(await prisma.flagState.count({ where: { flagId: flag.id } })).toBe(0);
  });
});

describe("audit log", () => {
  it("records created, updated, toggled and deleted, newest first, with the actor", async () => {
    const flag = (await createFlag(member)).body;
    const url = `${flagsUrl(wsId, projectId)}/${flag.id}`;
    await patch(member, url, { name: "Renamed" });
    await toggle(member, flag.id, devId, true);
    await del(admin, url);
    const res = await get(admin, `/workspaces/${wsId}/audit-log`);
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual([
      "flag.deleted",
      "flag.toggled",
      "flag.updated",
      "flag.created",
    ]);
    expect(res.body.entries[0].actor).toMatchObject({ id: admin.id, email: admin.email });
    expect(res.body.entries[3].actor.id).toBe(member.id);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });

  it("respects the limit and validates it", async () => {
    const flag = (await createFlag(owner)).body;
    for (let i = 0; i < 3; i++) await toggle(owner, flag.id, devId, i % 2 === 0);
    expect((await get(owner, `/workspaces/${wsId}/audit-log?limit=2`)).body.entries).toHaveLength(2);
    expect((await get(owner, `/workspaces/${wsId}/audit-log?limit=0`)).status).toBe(400);
    expect((await get(owner, `/workspaces/${wsId}/audit-log?limit=101`)).status).toBe(400);
  });

  it("is readable by ADMIN and up only", async () => {
    for (const u of [owner, admin]) expect((await get(u, `/workspaces/${wsId}/audit-log`)).status).toBe(200);
    for (const u of [member, viewer]) expect((await get(u, `/workspaces/${wsId}/audit-log`)).status).toBe(403);
  });

  it("never shows another tenant's entries", async () => {
    await createFlag(outsider, { key: "secret-flag", name: "Secret" }, otherWsId, otherProjectId);
    await createFlag(owner);
    const mine = (await get(owner, `/workspaces/${wsId}/audit-log`)).body.entries;
    expect(JSON.stringify(mine)).not.toContain("secret-flag");
    expect(mine.every((e: { workspaceId: string }) => e.workspaceId === wsId)).toBe(true);
    expect((await get(outsider, `/workspaces/${wsId}/audit-log`)).status).toBe(404);
  });
});

describe("permissions", () => {
  it("requires authentication", async () => {
    expect((await request(app).get(flagsUrl(wsId, projectId))).status).toBe(401);
  });

  it("lets every role read flags", async () => {
    const flag = (await createFlag(owner)).body;
    for (const u of [owner, admin, member, viewer]) {
      expect((await get(u, flagsUrl(wsId, projectId))).status).toBe(200);
      expect((await get(u, `${flagsUrl(wsId, projectId)}/${flag.id}`)).status).toBe(200);
    }
  });

  it("forbids VIEWER from creating, updating or toggling", async () => {
    const flag = (await createFlag(owner)).body;
    const url = `${flagsUrl(wsId, projectId)}/${flag.id}`;
    expect((await createFlag(viewer, { key: "nope-flag", name: "n" })).status).toBe(403);
    expect((await patch(viewer, url, { name: "x" })).status).toBe(403);
    expect((await toggle(viewer, flag.id, devId, true)).status).toBe(403);
    expect(await prisma.flagState.count()).toBe(0);
  });

  it("lets MEMBER create, update and toggle, but not delete", async () => {
    const flag = (await createFlag(member)).body;
    const url = `${flagsUrl(wsId, projectId)}/${flag.id}`;
    expect((await patch(member, url, { name: "Mine" })).status).toBe(200);
    expect((await toggle(member, flag.id, devId, true)).status).toBe(200);
    expect((await del(member, url)).status).toBe(403);
    expect(await prisma.flag.count({ where: { id: flag.id } })).toBe(1);
  });

  it("lets ADMIN delete a flag and removes its states", async () => {
    const flag = (await createFlag(member)).body;
    await toggle(member, flag.id, devId, true);
    expect((await del(admin, `${flagsUrl(wsId, projectId)}/${flag.id}`)).status).toBe(204);
    expect(await prisma.flag.count()).toBe(0);
    expect(await prisma.flagState.count()).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("hides the workspace from non-members on every flag route (404)", async () => {
    const flag = (await createFlag(owner)).body;
    const url = `${flagsUrl(wsId, projectId)}/${flag.id}`;
    const results = await Promise.all([
      get(outsider, flagsUrl(wsId, projectId)),
      createFlag(outsider, { key: "evil", name: "Evil" }, wsId, projectId),
      get(outsider, url),
      patch(outsider, url, { name: "Hacked" }),
      toggle(outsider, flag.id, devId, true),
      del(outsider, url),
    ]);
    for (const res of results) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("WORKSPACE_NOT_FOUND");
    }
    const row = await prisma.flag.findUniqueOrThrow({ where: { id: flag.id } });
    expect(row.name).toBe("New checkout");
    expect(await prisma.flagState.count()).toBe(0);
  });

  it("cannot reach another tenant's flag through your own workspace and project ids", async () => {
    const victim = (await createFlag(outsider, { key: "victim", name: "Victim" }, otherWsId, otherProjectId)).body;
    const results = await Promise.all([
      get(owner, `${flagsUrl(wsId, projectId)}/${victim.id}`),
      patch(owner, `${flagsUrl(wsId, projectId)}/${victim.id}`, { name: "Hacked" }),
      toggle(owner, victim.id, devId, true),
      del(owner, `${flagsUrl(wsId, projectId)}/${victim.id}`),
    ]);
    for (const res of results) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("FLAG_NOT_FOUND");
    }
    // Using the victim's project id inside our own workspace path:
    expect((await get(owner, flagsUrl(wsId, otherProjectId))).status).toBe(404);
    expect((await createFlag(owner, { key: "evil", name: "Evil" }, wsId, otherProjectId)).status).toBe(404);
    const row = await prisma.flag.findUniqueOrThrow({ where: { id: victim.id } });
    expect(row.name).toBe("Victim");
  });

  it("cannot toggle your flag in another tenant's environment (or another project's)", async () => {
    const flag = (await createFlag(owner)).body;
    const foreign = await toggle(owner, flag.id, otherEnvId, true);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("ENVIRONMENT_NOT_FOUND");

    const sibling = (await post(owner, `/workspaces/${wsId}/projects`, { name: "Mobile", key: "mobile" })).body;
    const siblingEnv = sibling.environments[0].id;
    const crossProject = await toggle(owner, flag.id, siblingEnv, true);
    expect(crossProject.status).toBe(404);
    expect(await prisma.flagState.count()).toBe(0);
  });

  it("keeps the same flag key independent across tenants", async () => {
    await createFlag(owner);
    const other = await createFlag(outsider, { key: "new-checkout", name: "Theirs" }, otherWsId, otherProjectId);
    expect(other.status).toBe(201);
    expect((await get(owner, flagsUrl(wsId, projectId))).body.flags).toHaveLength(1);
    expect((await get(outsider, flagsUrl(otherWsId, otherProjectId))).body.flags[0].name).toBe("Theirs");
  });
});
