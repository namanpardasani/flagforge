import { pino } from "pino";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scheduledChangesOf } from "../src/app.js";
import { startScheduler } from "../src/schedule/service.js";
import { makeApp, prisma, registerUser, resetDb, type TestUser } from "./helpers.js";

const app = makeApp();
const scheduled = scheduledChangesOf(app);

let owner: TestUser, admin: TestUser, member: TestUser, viewer: TestUser, outsider: TestUser;
let wsId: string, projectId: string, flagId: string, devId: string, prodId: string;

const as = (u: TestUser) => ({
  get: (path: string) => request(app).get(path).set("Authorization", u.auth),
  post: (path: string, body: object = {}) => request(app).post(path).set("Authorization", u.auth).send(body),
  put: (path: string, body: object) => request(app).put(path).set("Authorization", u.auth).send(body),
  del: (path: string) => request(app).delete(path).set("Authorization", u.auth),
});
const project = (ws = wsId, p = projectId) => `/workspaces/${ws}/projects/${p}`;
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const schedule = (u: TestUser, change: object, runAt = inMinutes(10), envId = devId, flag = flagId) =>
  as(u).post(`${project()}/flags/${flag}/environments/${envId}/schedule`, { runAt, change });
/** Makes planned changes due now, by moving their time into the past (the API itself refuses past times). */
const makeDue = (id?: string) => prisma.scheduledChange.updateMany({ where: id ? { id } : {}, data: { runAt: new Date(Date.now() - 5_000) } });
const state = async (envId = devId) => (await as(owner).get(`${project()}/flags`)).body.flags[0].environments.find((e: { environmentId: string }) => e.environmentId === envId);
const version = async (envId = devId) => (await prisma.environment.findUniqueOrThrow({ where: { id: envId } })).configVersion;
const row = (id: string) => prisma.scheduledChange.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await resetDb();
  [owner, admin, member, viewer, outsider] = (await Promise.all(["owner", "admin", "member", "viewer", "outsider"].map((n) => registerUser(app, `${n}@example.com`)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  wsId = (await as(owner).post("/workspaces", { name: "Acme", slug: "acme" })).body.id;
  for (const [u, role] of [[admin, "ADMIN"], [member, "MEMBER"], [viewer, "VIEWER"]] as const) await as(owner).post(`/workspaces/${wsId}/members`, { email: u.email, role });
  const created = (await as(owner).post(`/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = created.id;
  devId = created.environments.find((e: { key: string }) => e.key === "dev").id;
  prodId = created.environments.find((e: { key: string }) => e.key === "prod").id;
  flagId = (await as(owner).post(`${project()}/flags`, { key: "checkout", name: "Checkout" })).body.id;
});

describe("planning a change", () => {
  it("a member plans one; it is stored, listed as pending, and nothing changes yet", async () => {
    const res = await schedule(member, { rolloutPercentage: 25 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "PENDING", patch: { rolloutPercentage: 25 }, flag: { key: "checkout" }, environment: { key: "dev" }, createdBy: { id: member.id }, appliedAt: null, failure: null });
    expect((await state()).rolloutPercentage).toBe(100);
    const list = await as(viewer).get(`${project()}/scheduled-changes`);
    expect(list.body.scheduledChanges.map((c: { id: string }) => c.id)).toEqual([res.body.id]);
  });

  it("a viewer cannot plan or cancel; outsiders get 404 for everything", async () => {
    expect((await schedule(viewer, { enabled: true })).status).toBe(403);
    const id = (await schedule(member, { enabled: true })).body.id;
    expect((await as(viewer).del(`${project()}/scheduled-changes/${id}`)).status).toBe(403);
    expect((await schedule(outsider, { enabled: true })).status).toBe(404);
    expect((await as(outsider).get(`${project()}/scheduled-changes`)).status).toBe(404);
    expect((await as(outsider).del(`${project()}/scheduled-changes/${id}`)).status).toBe(404);
  });

  it("uses exactly the validation of a normal change", async () => {
    for (const change of [{}, { rolloutPercentage: 101 }, { rolloutPercentage: -1 }, { rolloutPercentage: 12.345 }, { enabled: "yes" }, { surprise: 1 }, { rules: [{ conditions: [], rolloutPercentage: 10 }] }]) {
      expect((await schedule(member, change)).status, JSON.stringify(change)).toBe(400);
    }
    expect((await schedule(member, { enabled: true, rolloutPercentage: 12.5, rules: [{ conditions: [{ attribute: "plan", operator: "equals", value: "pro" }], rolloutPercentage: 100 }] })).status).toBe(201);
  });

  it("refuses times that are too soon, too far, in the past, or ambiguous", async () => {
    expect((await schedule(member, { enabled: true }, inMinutes(0.5))).body.error.code).toBe("RUN_AT_TOO_SOON");
    expect((await schedule(member, { enabled: true }, inMinutes(-30))).body.error.code).toBe("RUN_AT_TOO_SOON");
    expect((await schedule(member, { enabled: true }, new Date(Date.now() + 400 * 86_400_000).toISOString())).body.error.code).toBe("RUN_AT_TOO_FAR");
    for (const runAt of ["2099-01-01T09:00:00", "tomorrow", "", "2099-13-45T00:00:00Z", 1_900_000_000_000]) {
      expect((await as(member).post(`${project()}/flags/${flagId}/environments/${devId}/schedule`, { runAt, change: { enabled: true } })).status, String(runAt)).toBe(400);
    }
  });

  it("accepts a time with an offset and stores the exact moment", async () => {
    const at = new Date(Date.now() + 3_600_000);
    const withOffset = at.toISOString().replace("Z", "+00:00");
    const res = await schedule(member, { enabled: true }, withOffset);
    expect(res.status).toBe(201);
    expect(new Date(res.body.runAt).getTime()).toBe(at.getTime());
  });

  it("cannot reach another tenant's flag or environment", async () => {
    const otherWs = (await as(outsider).post("/workspaces", { name: "Other", slug: "other" })).body.id;
    const other = (await as(outsider).post(`/workspaces/${otherWs}/projects`, { name: "Theirs", key: "theirs" })).body;
    const theirFlag = (await as(outsider).post(`/workspaces/${otherWs}/projects/${other.id}/flags`, { key: "theirs", name: "T" })).body.id;
    expect((await schedule(member, { enabled: true }, inMinutes(10), devId, theirFlag)).status).toBe(404);
    expect((await schedule(member, { enabled: true }, inMinutes(10), other.environments[0].id)).status).toBe(404);
    // And their scheduled changes never show in our list.
    await as(outsider).post(`/workspaces/${otherWs}/projects/${other.id}/flags/${theirFlag}/environments/${other.environments[0].id}/schedule`, { runAt: inMinutes(10), change: { enabled: true } });
    expect((await as(owner).get(`${project()}/scheduled-changes`)).body.scheduledChanges).toEqual([]);
    expect((await as(owner).get(`${project(otherWs, other.id)}/scheduled-changes`)).status).toBe(404);
  });

  it("limits how many may wait for one flag and environment", async () => {
    for (let i = 0; i < 20; i++) expect((await schedule(member, { rolloutPercentage: i + 1 }, inMinutes(10 + i))).status).toBe(201);
    const over = await schedule(member, { rolloutPercentage: 50 }, inMinutes(100));
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("TOO_MANY_SCHEDULED");
    expect((await schedule(member, { rolloutPercentage: 50 }, inMinutes(100), prodId)).status).toBe(201); // another environment has its own allowance
  });

  it("writes an audit entry, with who planned what and when", async () => {
    const res = await schedule(member, { rolloutPercentage: 25 }, "2099-01-01T09:00:00+02:00");
    expect(res.status).toBe(400); // too far ahead: nothing recorded for a refusal
    const ok = await schedule(member, { rolloutPercentage: 25 });
    const entry = (await as(owner).get(`/workspaces/${wsId}/audit-log`)).body.entries[0];
    expect(entry).toMatchObject({ action: "flag.schedule_created", entityType: "flag", entityId: flagId, actor: { id: member.id } });
    expect(entry.metadata).toMatchObject({ key: "checkout", environmentKey: "dev", scheduledChangeId: ok.body.id, change: { rolloutPercentage: 25 } });
  });
});

describe("cancelling", () => {
  it("a waiting change can be cancelled, once, and then never runs", async () => {
    const id = (await schedule(member, { enabled: true })).body.id;
    expect((await as(member).del(`${project()}/scheduled-changes/${id}`)).status).toBe(204);
    expect((await row(id)).status).toBe("CANCELLED");
    const again = await as(member).del(`${project()}/scheduled-changes/${id}`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("NOT_PENDING");
    await makeDue(id);
    expect(await scheduled.runDue()).toEqual({ applied: 0, failed: 0 });
    expect((await state()).enabled).toBe(false);
    const history = await as(viewer).get(`${project()}/scheduled-changes?status=history`);
    expect(history.body.scheduledChanges.map((c: { status: string }) => c.status)).toEqual(["CANCELLED"]);
  });

  it("a change that already ran cannot be cancelled", async () => {
    const id = (await schedule(member, { enabled: true })).body.id;
    await makeDue(id);
    await scheduled.runDue();
    expect((await as(member).del(`${project()}/scheduled-changes/${id}`)).status).toBe(409);
  });

  it("an unknown change is a 404", async () => {
    expect((await as(member).del(`${project()}/scheduled-changes/nope`)).status).toBe(404);
  });
});

describe("running due changes", () => {
  const runAgain = () => scheduled.runDue();

  it("applies a due change like a person would: state, version, audit trail", async () => {
    const id = (await schedule(member, { enabled: true, rolloutPercentage: 25 })).body.id;
    const before = await version();
    expect(await scheduled.runDue()).toEqual({ applied: 0, failed: 0 }); // not due yet
    expect((await state()).enabled).toBe(false);

    await makeDue(id);
    expect(await scheduled.runDue()).toEqual({ applied: 1, failed: 0 });
    expect(await state()).toMatchObject({ enabled: true, rolloutPercentage: 25 });
    expect(await version()).toBe(before + 1); // SDKs are told, exactly as for a manual change
    const done = await row(id);
    expect(done).toMatchObject({ status: "APPLIED", failure: null });
    expect(done.appliedAt).not.toBeNull();

    const actions = (await as(owner).get(`/workspaces/${wsId}/audit-log`)).body.entries.map((e: { action: string }) => e.action);
    expect(actions.slice(0, 3)).toEqual(["flag.schedule_applied", "flag.targeting_updated", "flag.toggled"]);
    expect(await runAgain()).toEqual({ applied: 0, failed: 0 }); // it is not applied twice
  });

  it("a ramp: several changes for one flag land in the order they were planned", async () => {
    const first = (await schedule(member, { enabled: true, rolloutPercentage: 10 }, inMinutes(10))).body.id;
    const second = (await schedule(member, { rolloutPercentage: 50 }, inMinutes(20))).body.id;
    const third = (await schedule(member, { rolloutPercentage: 100 }, inMinutes(30))).body.id;
    // Everything is overdue at once (the server was asleep): the order still follows the plan.
    await prisma.scheduledChange.update({ where: { id: first }, data: { runAt: new Date(Date.now() - 30_000) } });
    await prisma.scheduledChange.update({ where: { id: second }, data: { runAt: new Date(Date.now() - 20_000) } });
    await prisma.scheduledChange.update({ where: { id: third }, data: { runAt: new Date(Date.now() - 10_000) } });
    expect(await scheduled.runDue()).toEqual({ applied: 3, failed: 0 });
    expect(await state()).toMatchObject({ enabled: true, rolloutPercentage: 100 }); // the last one wins
    const targeting = (await as(owner).get(`/workspaces/${wsId}/audit-log?limit=50`)).body.entries.filter((e: { action: string }) => e.action === "flag.targeting_updated").reverse();
    expect(targeting.map((e: { metadata: { after: { fallthroughBps: number } } }) => e.metadata.after.fallthroughBps / 100)).toEqual([10, 50, 100]);
  });

  it("changes only the environment it names", async () => {
    const id = (await schedule(member, { enabled: true })).body.id; // dev
    await makeDue(id);
    await scheduled.runDue();
    expect((await state(devId)).enabled).toBe(true);
    expect((await state(prodId)).enabled).toBe(false);
  });

  it("applies targeting rules too", async () => {
    const id = (await schedule(member, { enabled: true, rules: [{ conditions: [{ attribute: "plan", operator: "equals", value: "pro" }], rolloutPercentage: 100 }] })).body.id;
    await makeDue(id);
    await scheduled.runDue();
    expect((await state()).rules).toHaveLength(1);
  });

  it("two runners at the same moment never apply the same change twice", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await schedule(member, { rolloutPercentage: 10 + i }, inMinutes(10 + i))).body.id);
    await makeDue();
    const [a, b] = await Promise.all([scheduled.runDue(), scheduled.runDue()]);
    expect(a.applied + b.applied).toBe(6);
    expect(a.failed + b.failed).toBe(0);
    const applied = (await as(owner).get(`/workspaces/${wsId}/audit-log?limit=100`)).body.entries.filter((e: { action: string }) => e.action === "flag.schedule_applied");
    expect(applied).toHaveLength(6);
    expect(new Set(applied.map((e: { metadata: { scheduledChangeId: string } }) => e.metadata.scheduledChangeId)).size).toBe(6);
    for (const id of ids) expect((await row(id)).status).toBe("APPLIED");
  });

  it("a change whose planner lost the right to change flags fails safely and says why", async () => {
    const id = (await schedule(member, { enabled: true })).body.id;
    await request(app).patch(`/workspaces/${wsId}/members/${member.id}`).set("Authorization", owner.auth).send({ role: "VIEWER" }).expect(200);
    await makeDue(id);
    expect(await scheduled.runDue()).toEqual({ applied: 0, failed: 1 });
    expect((await state()).enabled).toBe(false);
    expect(await row(id)).toMatchObject({ status: "FAILED", failure: "The person who scheduled this can no longer change flags" });
    const entry = (await as(owner).get(`/workspaces/${wsId}/audit-log`)).body.entries[0];
    expect(entry).toMatchObject({ action: "flag.schedule_failed" });
    expect(entry.metadata.failure).toMatch(/can no longer change flags/);
  });

  it("a change whose planner was removed from the workspace fails safely", async () => {
    const id = (await schedule(member, { enabled: true })).body.id;
    await request(app).delete(`/workspaces/${wsId}/members/${member.id}`).set("Authorization", owner.auth).expect(204);
    await makeDue(id);
    expect(await scheduled.runDue()).toEqual({ applied: 0, failed: 1 });
    expect((await row(id)).failure).toBe("The person who scheduled this is no longer in the workspace");
    expect((await state()).enabled).toBe(false);
  });

  it("a change whose planner's account was deleted fails safely, and the log still records it", async () => {
    const id = (await schedule(member, { enabled: true })).body.id;
    await prisma.user.delete({ where: { id: member.id } });
    await makeDue(id);
    expect(await scheduled.runDue()).toEqual({ applied: 0, failed: 1 });
    expect((await row(id)).status).toBe("FAILED");
    const entry = (await as(owner).get(`/workspaces/${wsId}/audit-log`)).body.entries[0];
    expect(entry).toMatchObject({ action: "flag.schedule_failed", actor: null });
  });

  it("a stored change that is no longer valid fails; it never reaches the flag", async () => {
    const id = (await schedule(member, { enabled: true })).body.id;
    await prisma.scheduledChange.update({ where: { id }, data: { patch: { rolloutPercentage: 5000, nonsense: true } } }); // edited by hand
    await makeDue(id);
    expect(await scheduled.runDue()).toEqual({ applied: 0, failed: 1 });
    expect((await row(id)).failure).toBe("The stored change is no longer valid");
    expect((await state()).rolloutPercentage).toBe(100);
  });

  it("one failure does not stop the others", async () => {
    const bad = (await schedule(member, { enabled: true }, inMinutes(10))).body.id;
    const good = (await schedule(member, { rolloutPercentage: 40 }, inMinutes(20))).body.id;
    await prisma.scheduledChange.update({ where: { id: bad }, data: { patch: "garbage" } });
    await makeDue();
    expect(await scheduled.runDue()).toEqual({ applied: 1, failed: 1 });
    expect((await row(good)).status).toBe("APPLIED");
    expect((await state()).rolloutPercentage).toBe(40);
  });

  it("a claim abandoned by a dead process is taken over after five minutes, and not before", async () => {
    const id = (await schedule(member, { enabled: true })).body.id;
    await makeDue(id);
    await prisma.scheduledChange.update({ where: { id }, data: { status: "RUNNING", claimedAt: new Date(Date.now() - 60_000) } }); // claimed a minute ago: still being worked on
    expect(await scheduled.runDue()).toEqual({ applied: 0, failed: 0 });
    expect((await state()).enabled).toBe(false);
    await prisma.scheduledChange.update({ where: { id }, data: { claimedAt: new Date(Date.now() - 6 * 60_000) } });
    expect(await scheduled.runDue()).toEqual({ applied: 1, failed: 0 });
    expect((await state()).enabled).toBe(true);
  });

  it("deleting the flag removes what was planned for it", async () => {
    await schedule(member, { enabled: true });
    await as(admin).del(`${project()}/flags/${flagId}`).expect(204);
    expect(await prisma.scheduledChange.count()).toBe(0);
  });

  it("history shows what happened, newest first, separately from what is waiting", async () => {
    const a = (await schedule(member, { rolloutPercentage: 10 }, inMinutes(10))).body.id;
    const b = (await schedule(member, { rolloutPercentage: 20 }, inMinutes(20))).body.id;
    const c = (await schedule(member, { rolloutPercentage: 30 }, inMinutes(30))).body.id;
    await as(member).del(`${project()}/scheduled-changes/${c}`);
    await prisma.scheduledChange.update({ where: { id: a }, data: { runAt: new Date(Date.now() - 20_000) } });
    await scheduled.runDue();
    const pending = (await as(viewer).get(`${project()}/scheduled-changes`)).body.scheduledChanges.map((x: { id: string }) => x.id);
    const history = (await as(viewer).get(`${project()}/scheduled-changes?status=history`)).body.scheduledChanges.map((x: { id: string; status: string }) => `${x.status}`);
    expect(pending).toEqual([b]);
    expect(history.sort()).toEqual(["APPLIED", "CANCELLED"]);
    expect((await as(viewer).get(`${project()}/scheduled-changes?status=nonsense`)).status).toBe(400);
    expect((await as(viewer).get(`${project()}/scheduled-changes?flagId=${flagId}`)).body.scheduledChanges).toHaveLength(1);
  });
});

describe("the runner", () => {
  it("applies due changes by itself, one pass at a time, and stops when told", async () => {
    const id = (await schedule(member, { enabled: true })).body.id;
    await makeDue(id);
    const scheduler = startScheduler(scheduled, pino({ level: "silent" }), 20);
    await vi.waitFor(async () => expect((await row(id)).status).toBe("APPLIED"), { timeout: 3000, interval: 20 });
    await scheduler.stop();
    // Nothing is picked up after it stopped.
    const later = (await schedule(member, { rolloutPercentage: 70 })).body.id;
    await makeDue(later);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await row(later)).status).toBe("PENDING");
  });

  it("catches up straight away at start-up, without waiting for the first tick", async () => {
    const id = (await schedule(member, { enabled: true })).body.id;
    await makeDue(id);
    const scheduler = startScheduler(scheduled, pino({ level: "silent" }), 60_000);
    await vi.waitFor(async () => expect((await row(id)).status).toBe("APPLIED"), { timeout: 3000, interval: 20 });
    await scheduler.stop();
  });

  it("a pass that throws is logged and the runner carries on", async () => {
    let calls = 0;
    const flaky = { runDue: async () => { calls++; if (calls === 1) throw new Error("database blip"); return { applied: 0, failed: 0 }; } };
    const scheduler = startScheduler(flaky, pino({ level: "silent" }), 20);
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 3000, interval: 10 });
    await scheduler.stop();
  });

  it("never runs two passes at once, however slow one is", async () => {
    let active = 0;
    let peak = 0;
    const slow = { runDue: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 80)); active--; return { applied: 0, failed: 0 }; } };
    const scheduler = startScheduler(slow, pino({ level: "silent" }), 10);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await scheduler.stop();
    expect(peak).toBe(1);
  });
});
