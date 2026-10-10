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
let projectId: string; // in owner's workspace
let otherProjectId: string; // in outsider's workspace

const base = (ws: string) => `/workspaces/${ws}/projects`;
const api = {
  createWs: (u: TestUser, body: object) => request(app).post("/workspaces").set("Authorization", u.auth).send(body),
  addMember: (u: TestUser, ws: string, body: object) =>
    request(app).post(`/workspaces/${ws}/members`).set("Authorization", u.auth).send(body),
  createProject: (u: TestUser, ws: string, body: object) =>
    request(app).post(base(ws)).set("Authorization", u.auth).send(body),
  listProjects: (u: TestUser, ws: string) => request(app).get(base(ws)).set("Authorization", u.auth),
  getProject: (u: TestUser, ws: string, p: string) => request(app).get(`${base(ws)}/${p}`).set("Authorization", u.auth),
  deleteProject: (u: TestUser, ws: string, p: string) =>
    request(app).delete(`${base(ws)}/${p}`).set("Authorization", u.auth),
  createEnv: (u: TestUser, ws: string, p: string, body: object) =>
    request(app).post(`${base(ws)}/${p}/environments`).set("Authorization", u.auth).send(body),
  listEnvs: (u: TestUser, ws: string, p: string) =>
    request(app).get(`${base(ws)}/${p}/environments`).set("Authorization", u.auth),
  deleteEnv: (u: TestUser, ws: string, p: string, e: string) =>
    request(app).delete(`${base(ws)}/${p}/environments/${e}`).set("Authorization", u.auth),
};

beforeEach(async () => {
  await resetDb();
  [owner, admin, member, viewer, outsider] = (await Promise.all(
    ["owner", "admin", "member", "viewer", "outsider"].map((n) => registerUser(app, `${n}@example.com`)),
  )) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  wsId = (await api.createWs(owner, { name: "Acme", slug: "acme" })).body.id;
  otherWsId = (await api.createWs(outsider, { name: "Other Co", slug: "other-co" })).body.id;
  await api.addMember(owner, wsId, { email: admin.email, role: "ADMIN" });
  await api.addMember(owner, wsId, { email: member.email, role: "MEMBER" });
  await api.addMember(owner, wsId, { email: viewer.email, role: "VIEWER" });
  projectId = (await api.createProject(owner, wsId, { name: "Web App", key: "web-app" })).body.id;
  otherProjectId = (await api.createProject(outsider, otherWsId, { name: "Secret", key: "secret" })).body.id;
});

describe("projects", () => {
  it("creates a project in the workspace and returns it with environments", async () => {
    const res = await api.createProject(admin, wsId, { name: "Mobile", key: "Mobile" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Mobile", key: "mobile", workspaceId: wsId });
    const got = await api.getProject(viewer, wsId, res.body.id);
    expect(got.status).toBe(200);
    expect(got.body.environments).toEqual([]);
  });

  it("allows the same key in different workspaces but not twice in one", async () => {
    const dup = await api.createProject(owner, wsId, { name: "Again", key: "web-app" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("PROJECT_KEY_TAKEN");
    const otherTenant = await api.createProject(outsider, otherWsId, { name: "Web", key: "web-app" });
    expect(otherTenant.status).toBe(201);
  });

  it("validates input", async () => {
    for (const body of [{}, { name: "X" }, { name: "", key: "ok" }, { name: "X", key: "Bad Key" }, { name: "X", key: "a" }]) {
      expect((await api.createProject(owner, wsId, body)).status).toBe(400);
    }
  });

  it("lists only this workspace's projects", async () => {
    const res = await api.listProjects(viewer, wsId);
    expect(res.status).toBe(200);
    expect(res.body.projects.map((p: { id: string }) => p.id)).toEqual([projectId]);
  });

  it("deletes a project and its environments", async () => {
    const env = (await api.createEnv(owner, wsId, projectId, { name: "Prod", key: "prod" })).body;
    expect((await api.deleteProject(admin, wsId, projectId)).status).toBe(204);
    expect((await api.getProject(owner, wsId, projectId)).status).toBe(404);
    expect(await prisma.environment.findUnique({ where: { id: env.id } })).toBeNull();
  });
});

describe("environments", () => {
  it("creates environments with workspaceId taken from the project, unique per project", async () => {
    const res = await api.createEnv(owner, wsId, projectId, { name: "Production", key: "production" });
    expect(res.status).toBe(201);
    const row = await prisma.environment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.workspaceId).toBe(wsId);
    expect(row.projectId).toBe(projectId);

    const dup = await api.createEnv(owner, wsId, projectId, { name: "Prod 2", key: "production" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("ENVIRONMENT_KEY_TAKEN");

    const other = (await api.createProject(owner, wsId, { name: "Mobile", key: "mobile" })).body.id;
    expect((await api.createEnv(owner, wsId, other, { name: "Production", key: "production" })).status).toBe(201);
  });

  it("ignores a workspaceId smuggled into the request body", async () => {
    const res = await api.createEnv(owner, wsId, projectId, { name: "Dev", key: "dev", workspaceId: otherWsId });
    expect(res.status).toBe(201);
    const row = await prisma.environment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.workspaceId).toBe(wsId);
  });

  it("lists and deletes environments", async () => {
    const env = (await api.createEnv(owner, wsId, projectId, { name: "Dev", key: "dev" })).body;
    const list = await api.listEnvs(viewer, wsId, projectId);
    expect(list.body.environments.map((e: { id: string }) => e.id)).toEqual([env.id]);
    expect((await api.deleteEnv(admin, wsId, projectId, env.id)).status).toBe(204);
    expect((await api.deleteEnv(admin, wsId, projectId, env.id)).status).toBe(404);
  });
});

describe("tenant isolation", () => {
  it("hides another tenant's projects at the workspace level (404)", async () => {
    const results = await Promise.all([
      api.listProjects(outsider, wsId),
      api.createProject(outsider, wsId, { name: "Evil", key: "evil" }),
      api.getProject(outsider, wsId, projectId),
      api.deleteProject(outsider, wsId, projectId),
      api.createEnv(outsider, wsId, projectId, { name: "Evil", key: "evil" }),
      api.listEnvs(outsider, wsId, projectId),
    ]);
    for (const res of results) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("WORKSPACE_NOT_FOUND");
    }
    expect(await prisma.project.count({ where: { workspaceId: wsId } })).toBe(1);
    expect(await prisma.environment.count({ where: { workspaceId: wsId } })).toBe(0);
  });

  it("cannot reach another workspace's project through your own workspace id", async () => {
    // outsider's project id, but owner's workspace id (owner IS a member there).
    const results = await Promise.all([
      api.getProject(owner, wsId, otherProjectId),
      api.deleteProject(owner, wsId, otherProjectId),
      api.createEnv(owner, wsId, otherProjectId, { name: "Evil", key: "evil" }),
      api.listEnvs(owner, wsId, otherProjectId),
    ]);
    for (const res of results) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    }
    expect(await prisma.project.findUnique({ where: { id: otherProjectId } })).not.toBeNull();
    expect(await prisma.environment.count({ where: { projectId: otherProjectId } })).toBe(0);
  });

  it("cannot delete another workspace's environment via your own project path", async () => {
    const victimEnv = (await api.createEnv(outsider, otherWsId, otherProjectId, { name: "Prod", key: "prod" })).body;
    const res = await api.deleteEnv(owner, wsId, projectId, victimEnv.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ENVIRONMENT_NOT_FOUND");
    const viaForeignProject = await api.deleteEnv(owner, wsId, otherProjectId, victimEnv.id);
    expect(viaForeignProject.status).toBe(404);
    expect(await prisma.environment.findUnique({ where: { id: victimEnv.id } })).not.toBeNull();
  });
});

describe("permissions", () => {
  it("requires authentication", async () => {
    expect((await request(app).get(base(wsId))).status).toBe(401);
  });

  it("lets every role read", async () => {
    for (const u of [owner, admin, member, viewer]) {
      expect((await api.listProjects(u, wsId)).status).toBe(200);
      expect((await api.getProject(u, wsId, projectId)).status).toBe(200);
      expect((await api.listEnvs(u, wsId, projectId)).status).toBe(200);
    }
  });

  it("forbids MEMBER and VIEWER from creating or deleting projects and environments", async () => {
    const env = (await api.createEnv(owner, wsId, projectId, { name: "Dev", key: "dev" })).body;
    for (const u of [member, viewer]) {
      expect((await api.createProject(u, wsId, { name: "Nope", key: "nope" })).status).toBe(403);
      expect((await api.deleteProject(u, wsId, projectId)).status).toBe(403);
      expect((await api.createEnv(u, wsId, projectId, { name: "Nope", key: "nope" })).status).toBe(403);
      expect((await api.deleteEnv(u, wsId, projectId, env.id)).status).toBe(403);
    }
    expect(await prisma.project.count({ where: { workspaceId: wsId } })).toBe(1);
    expect(await prisma.environment.count({ where: { projectId } })).toBe(1);
  });

  it("lets ADMIN manage projects and environments", async () => {
    const p = await api.createProject(admin, wsId, { name: "Admin Proj", key: "admin-proj" });
    expect(p.status).toBe(201);
    expect((await api.createEnv(admin, wsId, p.body.id, { name: "Dev", key: "dev" })).status).toBe(201);
    expect((await api.deleteProject(admin, wsId, p.body.id)).status).toBe(204);
  });
});
