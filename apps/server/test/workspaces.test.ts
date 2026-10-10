import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { makeApp, prisma, registerUser, resetDb, type TestUser } from "./helpers.js";

const app = makeApp();

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser; // belongs to a different tenant
let wsId: string; // owner's workspace
let otherWsId: string; // outsider's workspace

const api = {
  create: (u: TestUser, body: object) => request(app).post("/workspaces").set("Authorization", u.auth).send(body),
  get: (u: TestUser, id: string) => request(app).get(`/workspaces/${id}`).set("Authorization", u.auth),
  members: (u: TestUser, id: string) => request(app).get(`/workspaces/${id}/members`).set("Authorization", u.auth),
  add: (u: TestUser, id: string, body: object) =>
    request(app).post(`/workspaces/${id}/members`).set("Authorization", u.auth).send(body),
  patch: (u: TestUser, id: string, target: string, body: object) =>
    request(app).patch(`/workspaces/${id}/members/${target}`).set("Authorization", u.auth).send(body),
  remove: (u: TestUser, id: string, target: string) =>
    request(app).delete(`/workspaces/${id}/members/${target}`).set("Authorization", u.auth),
};

async function roleInDb(workspaceId: string, userId: string) {
  const row = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return row?.role ?? null;
}

beforeEach(async () => {
  await resetDb();
  [owner, admin, member, viewer, outsider] = await Promise.all(
    ["owner", "admin", "member", "viewer", "outsider"].map((n) => registerUser(app, `${n}@example.com`)),
  ) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  wsId = (await api.create(owner, { name: "Acme", slug: "acme" })).body.id;
  otherWsId = (await api.create(outsider, { name: "Other Co", slug: "other-co" })).body.id;
  await api.add(owner, wsId, { email: admin.email, role: "ADMIN" });
  await api.add(owner, wsId, { email: member.email, role: "MEMBER" });
  await api.add(owner, wsId, { email: viewer.email, role: "VIEWER" });
});

describe("creating and listing workspaces", () => {
  it("makes the creator the OWNER, atomically with the workspace", async () => {
    const res = await api.create(owner, { name: "Second", slug: "second-one" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Second", slug: "second-one", plan: "free", role: "OWNER" });
    expect(await roleInDb(res.body.id, owner.id)).toBe("OWNER");
  });

  it("rejects a duplicate slug with 409 and invalid input with 400", async () => {
    const dup = await api.create(outsider, { name: "Copy", slug: "acme" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("SLUG_TAKEN");
    for (const slug of ["AB", "has space", "-lead", "trail-", "dou--ble", "x".repeat(41)]) {
      const res = await api.create(owner, { name: "X", slug });
      expect(res.status, slug).toBe(400);
    }
    expect((await api.create(owner, { slug: "no-name" })).status).toBe(400);
  });

  it("requires authentication", async () => {
    expect((await request(app).post("/workspaces").send({ name: "X", slug: "xxx" })).status).toBe(401);
    expect((await request(app).get("/workspaces")).status).toBe(401);
  });

  it("lists only the caller's workspaces, each with the caller's role", async () => {
    const mine = await request(app).get("/workspaces").set("Authorization", admin.auth);
    expect(mine.body.workspaces).toHaveLength(1);
    expect(mine.body.workspaces[0]).toMatchObject({ id: wsId, role: "ADMIN" });
    const theirs = await request(app).get("/workspaces").set("Authorization", outsider.auth);
    expect(theirs.body.workspaces.map((w: { id: string }) => w.id)).toEqual([otherWsId]);
  });
});

describe("tenant isolation", () => {
  it("hides another tenant's workspace: every route returns 404, not 403", async () => {
    const results = await Promise.all([
      api.get(outsider, wsId),
      api.members(outsider, wsId),
      api.add(outsider, wsId, { email: "x@example.com", role: "MEMBER" }),
      api.patch(outsider, wsId, member.id, { role: "ADMIN" }),
      api.remove(outsider, wsId, member.id),
    ]);
    for (const res of results) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("returns the same 404 for a workspace that does not exist", async () => {
    const res = await api.get(owner, "does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("changes nothing in the victim workspace after attempted cross-tenant writes", async () => {
    await api.add(outsider, wsId, { email: outsider.email, role: "ADMIN" });
    await api.patch(outsider, wsId, member.id, { role: "ADMIN" });
    await api.remove(outsider, wsId, viewer.id);
    expect(await roleInDb(wsId, outsider.id)).toBeNull();
    expect(await roleInDb(wsId, member.id)).toBe("MEMBER");
    expect(await roleInDb(wsId, viewer.id)).toBe("VIEWER");
  });

  it("an admin of workspace A cannot touch a user who only belongs to workspace B", async () => {
    // outsider is not a member of wsId, so as far as wsId is concerned they do not exist.
    const patch = await api.patch(owner, wsId, outsider.id, { role: "VIEWER" });
    expect(patch.status).toBe(404);
    expect(patch.body.error.code).toBe("MEMBER_NOT_FOUND");
    const del = await api.remove(owner, wsId, outsider.id);
    expect(del.status).toBe(404);
    expect(await roleInDb(otherWsId, outsider.id)).toBe("OWNER");
  });

  it("member listings only contain that workspace's members", async () => {
    const res = await api.members(owner, wsId);
    const ids = res.body.members.map((m: { userId: string }) => m.userId).sort();
    expect(ids).toEqual([owner.id, admin.id, member.id, viewer.id].sort());
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|outsider/);
  });
});

describe("role permissions", () => {
  it("lets every role read the workspace and its members", async () => {
    for (const u of [owner, admin, member, viewer]) {
      expect((await api.get(u, wsId)).status).toBe(200);
      expect((await api.members(u, wsId)).status).toBe(200);
    }
    expect((await api.get(viewer, wsId)).body.role).toBe("VIEWER");
  });

  it("forbids MEMBER and VIEWER from adding, changing or removing members", async () => {
    for (const u of [member, viewer]) {
      expect((await api.add(u, wsId, { email: outsider.email, role: "VIEWER" })).status).toBe(403);
      expect((await api.patch(u, wsId, viewer.id, { role: "MEMBER" })).status).toBe(403);
      expect((await api.remove(u, wsId, admin.id)).status).toBe(403);
    }
    expect(await roleInDb(wsId, outsider.id)).toBeNull();
  });

  it("lets an ADMIN add MEMBER/VIEWER but not ADMIN", async () => {
    const ok = await api.add(admin, wsId, { email: outsider.email, role: "MEMBER" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ userId: outsider.id, role: "MEMBER" });
    await prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId: wsId, userId: outsider.id } },
    });
    const denied = await api.add(admin, wsId, { email: outsider.email, role: "ADMIN" });
    expect(denied.status).toBe(403);
  });

  it("never allows assigning OWNER", async () => {
    expect((await api.add(owner, wsId, { email: outsider.email, role: "OWNER" })).status).toBe(400);
    expect((await api.patch(owner, wsId, member.id, { role: "OWNER" })).status).toBe(400);
  });

  it("rejects adding someone twice or an unknown email", async () => {
    const dup = await api.add(owner, wsId, { email: member.email, role: "VIEWER" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("ALREADY_MEMBER");
    const unknown = await api.add(owner, wsId, { email: "ghost@example.com", role: "VIEWER" });
    expect(unknown.status).toBe(404);
  });

  it("lets ADMIN change MEMBER/VIEWER roles, but only OWNER touches admins", async () => {
    expect((await api.patch(admin, wsId, viewer.id, { role: "MEMBER" })).status).toBe(200);
    expect(await roleInDb(wsId, viewer.id)).toBe("MEMBER");
    expect((await api.patch(admin, wsId, member.id, { role: "ADMIN" })).status).toBe(403);
    expect((await api.patch(owner, wsId, member.id, { role: "ADMIN" })).status).toBe(200);
    expect((await api.patch(admin, wsId, member.id, { role: "VIEWER" })).status).toBe(403); // now an admin
    expect((await api.patch(owner, wsId, member.id, { role: "VIEWER" })).status).toBe(200);
  });

  it("protects the owner and forbids changing your own role", async () => {
    expect((await api.patch(admin, wsId, owner.id, { role: "VIEWER" })).status).toBe(403);
    expect((await api.remove(admin, wsId, owner.id)).status).toBe(403);
    expect((await api.remove(owner, wsId, owner.id)).status).toBe(403);
    expect((await api.patch(admin, wsId, admin.id, { role: "ADMIN" })).status).toBe(403);
    expect(await roleInDb(wsId, owner.id)).toBe("OWNER");
  });

  it("lets ADMIN remove members but only OWNER remove admins", async () => {
    expect((await api.remove(admin, wsId, member.id)).status).toBe(204);
    expect(await roleInDb(wsId, member.id)).toBeNull();
    const second = await registerUser(app, "admin2@example.com");
    await api.add(owner, wsId, { email: second.email, role: "ADMIN" });
    expect((await api.remove(admin, wsId, second.id)).status).toBe(403);
    expect((await api.remove(owner, wsId, second.id)).status).toBe(204);
  });

  it("lets any non-owner member leave, after which they lose access", async () => {
    expect((await api.remove(viewer, wsId, viewer.id)).status).toBe(204);
    expect((await api.get(viewer, wsId)).status).toBe(404);
  });

  it("validates the add-member body", async () => {
    for (const body of [{}, { email: "bad", role: "MEMBER" }, { email: member.email, role: "GOD" }]) {
      expect((await api.add(owner, wsId, body)).status).toBe(400);
    }
  });
});
