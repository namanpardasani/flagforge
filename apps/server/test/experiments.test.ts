import { analyzeExperiment } from "@flagforge/core";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { makeApp, prisma, registerUser, resetDb, type TestUser } from "./helpers.js";

const app = makeApp();

let owner: TestUser, admin: TestUser, member: TestUser, viewer: TestUser, outsider: TestUser;
let wsId: string, projectId: string, flagId: string, devId: string, prodId: string, devKey: string, prodKey: string;

const as = (u: TestUser) => ({
  get: (path: string) => request(app).get(path).set("Authorization", u.auth),
  post: (path: string, body: object = {}) => request(app).post(path).set("Authorization", u.auth).send(body),
  put: (path: string, body: object) => request(app).put(path).set("Authorization", u.auth).send(body),
  del: (path: string) => request(app).delete(path).set("Authorization", u.auth),
});
const base = (ws = wsId, p = projectId) => `/workspaces/${ws}/projects/${p}/experiments`;
const setFlag = (envId: string, body: object, flag = flagId) => as(owner).put(`/workspaces/${wsId}/projects/${projectId}/flags/${flag}/environments/${envId}`, body);
const create = (u: TestUser = member, body: object = {}) => as(u).post(base(), { name: "One-tap checkout", flagId, environmentId: devId, metricKey: "checkout-completed", ...body });
const events = (key: string, list: object[]) => request(app).post("/sdk/v1/events").set("Authorization", `Bearer ${key}`).send({ events: list });
const exposure = (userKey: string, value: boolean, flagKey = "checkout") => ({ type: "exposure", flagKey, userKey, value });
const conversion = (userKey: string, metricKey = "checkout-completed") => ({ type: "conversion", metricKey, userKey });
const results = async (id: string, u: TestUser = viewer) => (await as(u).get(`${base()}/${id}`)).body;

/** A running experiment on the dev environment with a 50% rollout. */
async function running() {
  await setFlag(devId, { enabled: true, rolloutPercentage: 50 });
  const id = (await create()).body.id as string;
  expect((await as(member).post(`${base()}/${id}/start`)).status).toBe(200);
  return id;
}

beforeEach(async () => {
  await resetDb();
  [owner, admin, member, viewer, outsider] = (await Promise.all(["owner", "admin", "member", "viewer", "outsider"].map((n) => registerUser(app, `${n}@example.com`)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  wsId = (await as(owner).post("/workspaces", { name: "Acme", slug: "acme" })).body.id;
  for (const [u, role] of [[admin, "ADMIN"], [member, "MEMBER"], [viewer, "VIEWER"]] as const) await as(owner).post(`/workspaces/${wsId}/members`, { email: u.email, role });
  const project = (await as(owner).post(`/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = project.id;
  devId = project.environments.find((e: { key: string }) => e.key === "dev").id;
  prodId = project.environments.find((e: { key: string }) => e.key === "prod").id;
  flagId = (await as(owner).post(`/workspaces/${wsId}/projects/${projectId}/flags`, { key: "checkout", name: "Checkout" })).body.id;
  const key = async (envId: string) => (await as(owner).post(`/workspaces/${wsId}/projects/${projectId}/environments/${envId}/api-keys`, { name: "k" })).body.key as string;
  devKey = await key(devId);
  prodKey = await key(prodId);
});

describe("creating and reading", () => {
  it("a member creates a draft; viewers can read it; it names its flag and environment", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "One-tap checkout", status: "DRAFT", metricKey: "checkout-completed", flag: { key: "checkout" }, environment: { key: "dev" }, startedAt: null });
    const list = await as(viewer).get(base());
    expect(list.body.experiments).toHaveLength(1);
  });

  it("viewers cannot create, start or stop; only admins delete", async () => {
    expect((await create(viewer)).status).toBe(403);
    await setFlag(devId, { enabled: true, rolloutPercentage: 50 });
    const id = (await create()).body.id;
    expect((await as(viewer).post(`${base()}/${id}/start`)).status).toBe(403);
    expect((await as(member).post(`${base()}/${id}/start`)).status).toBe(200);
    expect((await as(viewer).post(`${base()}/${id}/stop`)).status).toBe(403);
    expect((await as(member).del(`${base()}/${id}`)).status).toBe(403);
    expect((await as(admin).del(`${base()}/${id}`)).status).toBe(204);
  });

  it("validates input", async () => {
    expect((await create(member, { metricKey: "Has Spaces" })).status).toBe(400);
    expect((await create(member, { name: "" })).status).toBe(400);
    expect((await create(member, { extra: "field" })).status).toBe(400);
  });
});

describe("tenant isolation", () => {
  it("outsiders get 404 for everything", async () => {
    const id = (await create()).body.id;
    expect((await as(outsider).get(base())).status).toBe(404);
    expect((await as(outsider).get(`${base()}/${id}`)).status).toBe(404);
    expect((await as(outsider).post(`${base()}/${id}/start`)).status).toBe(404);
    expect((await as(outsider).del(`${base()}/${id}`)).status).toBe(404);
  });

  it("cannot attach an experiment to another tenant's flag or environment, nor reach theirs through its own workspace", async () => {
    const otherWs = (await as(outsider).post("/workspaces", { name: "Other", slug: "other" })).body.id;
    const otherProject = (await as(outsider).post(`/workspaces/${otherWs}/projects`, { name: "Their app", key: "their-app" })).body;
    const otherFlag = (await as(outsider).post(`/workspaces/${otherWs}/projects/${otherProject.id}/flags`, { key: "theirs", name: "T" })).body.id;
    expect((await create(member, { flagId: otherFlag })).status).toBe(404);
    expect((await create(member, { environmentId: otherProject.environments[0].id })).status).toBe(404);

    const mine = (await create()).body.id;
    // Their workspace id with OUR project and experiment ids: nothing found.
    expect((await as(outsider).get(`${base(otherWs, projectId)}/${mine}`)).status).toBe(404);
    expect((await as(outsider).get(`${base(otherWs, otherProject.id)}/${mine}`)).status).toBe(404);
  });

  it("another tenant's API key cannot add to this experiment, even for the same flag key and metric", async () => {
    const id = await running();
    const otherWs = (await as(outsider).post("/workspaces", { name: "Other", slug: "other" })).body.id;
    const otherProject = (await as(outsider).post(`/workspaces/${otherWs}/projects`, { name: "Their app", key: "their-app" })).body;
    await as(outsider).post(`/workspaces/${otherWs}/projects/${otherProject.id}/flags`, { key: "checkout", name: "C" });
    const theirKey = (await as(outsider).post(`/workspaces/${otherWs}/projects/${otherProject.id}/environments/${otherProject.environments[0].id}/api-keys`, { name: "k" })).body.key;

    const res = await events(theirKey, [exposure("u1", true), conversion("u1")]);
    expect(res.body).toMatchObject({ accepted: 2, exposures: 0, conversions: 0 });
    expect((await results(id)).groups).toEqual({ control: { users: 0, conversions: 0 }, treatment: { users: 0, conversions: 0 } });
  });
});

describe("starting and stopping", () => {
  it("refuses to start while the flag is off, with a reason", async () => {
    const id = (await create()).body.id;
    const res = await as(member).post(`${base()}/${id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("FLAG_OFF");
  });

  it("refuses to start when everyone or no one gets the flag", async () => {
    const id = (await create()).body.id;
    for (const rolloutPercentage of [100, 0]) {
      await setFlag(devId, { enabled: true, rolloutPercentage });
      const res = await as(member).post(`${base()}/${id}/start`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_SPLIT");
    }
    await setFlag(devId, { enabled: true, rolloutPercentage: 20 });
    const started = await as(member).post(`${base()}/${id}/start`);
    expect(started.body).toMatchObject({ status: "RUNNING" });
    expect(started.body.startedAt).not.toBeNull();
  });

  it("allows only one running experiment per flag and environment", async () => {
    await running();
    const second = (await create(member, { name: "Second" })).body.id;
    const res = await as(member).post(`${base()}/${second}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ANOTHER_EXPERIMENT_RUNNING");

    // The same flag in ANOTHER environment is a separate experiment and may run.
    await setFlag(prodId, { enabled: true, rolloutPercentage: 50 });
    const inProd = (await create(member, { name: "In prod", environmentId: prodId })).body.id;
    expect((await as(member).post(`${base()}/${inProd}/start`)).status).toBe(200);
  });

  it("two people pressing Start at once: exactly one succeeds (the database decides)", async () => {
    await setFlag(devId, { enabled: true, rolloutPercentage: 50 });
    const [a, b] = [(await create(member, { name: "A" })).body.id, (await create(member, { name: "B" })).body.id];
    const outcomes = await Promise.all([as(member).post(`${base()}/${a}/start`), as(admin).post(`${base()}/${b}/start`)]);
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.experiment.count({ where: { flagId, environmentId: devId, status: "RUNNING" } })).toBe(1);
  });

  it("a stopped experiment keeps its data, takes no more, and cannot be restarted", async () => {
    const id = await running();
    await events(devKey, [exposure("u1", true), conversion("u1")]);
    const stopped = await as(member).post(`${base()}/${id}/stop`);
    expect(stopped.body).toMatchObject({ status: "STOPPED" });
    expect(stopped.body.stoppedAt).not.toBeNull();

    expect((await events(devKey, [exposure("u2", false), conversion("u2")])).body).toMatchObject({ exposures: 0, conversions: 0 });
    expect((await results(id)).groups.treatment).toEqual({ users: 1, conversions: 1 });
    expect((await as(member).post(`${base()}/${id}/start`)).body.error.code).toBe("EXPERIMENT_FINISHED");
    expect((await as(member).post(`${base()}/${id}/stop`)).body.error.code).toBe("NOT_RUNNING");
    // Once it is stopped, a new experiment on the same flag may start.
    const next = (await create(member, { name: "Next" })).body.id;
    expect((await as(member).post(`${base()}/${next}/start`)).status).toBe(200);
  });
});

describe("counting events", () => {
  it("counts each user once, keeps the first variant they were seen with", async () => {
    const id = await running();
    const res = await events(devKey, [exposure("u1", true), exposure("u1", true), exposure("u2", false), exposure("u1", false)]);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 4, exposures: 2, conversions: 0 });
    // The same users again, and u1 now claiming the other variant: nothing changes.
    expect((await events(devKey, [exposure("u1", false), exposure("u2", true)])).body.exposures).toBe(0);
    expect((await results(id)).groups).toEqual({ control: { users: 1, conversions: 0 }, treatment: { users: 1, conversions: 0 } });
  });

  it("counts a conversion once per user, and only for users who were exposed", async () => {
    const id = await running();
    await events(devKey, [exposure("u1", true), exposure("u2", false)]);
    const res = await events(devKey, [conversion("u1"), conversion("u1"), conversion("never-exposed")]);
    expect(res.body).toMatchObject({ exposures: 0, conversions: 1 });
    await events(devKey, [conversion("u1"), conversion("u2")]);
    expect((await results(id)).groups).toEqual({ control: { users: 1, conversions: 1 }, treatment: { users: 1, conversions: 1 } });
  });

  it("an exposure and a conversion in the same batch both count", async () => {
    const id = await running();
    expect((await events(devKey, [conversion("u1"), exposure("u1", true)])).body).toMatchObject({ exposures: 1, conversions: 1 });
    expect((await results(id)).groups.treatment).toEqual({ users: 1, conversions: 1 });
  });

  it("ignores other flags, other metrics, and drafts", async () => {
    const id = await running();
    const draft = (await create(member, { name: "Draft", environmentId: prodId })).body.id;
    await events(devKey, [exposure("u1", true, "some-other-flag"), exposure("u2", true), conversion("u2", "something-else")]);
    await events(prodKey, [exposure("u9", true), conversion("u9")]); // prod has only a draft
    expect((await results(id)).groups).toEqual({ control: { users: 0, conversions: 0 }, treatment: { users: 1, conversions: 0 } });
    expect((await results(draft)).groups.treatment.users).toBe(0);
  });

  it("a key only feeds experiments in its own environment", async () => {
    const id = await running(); // dev
    expect((await events(prodKey, [exposure("u1", true), conversion("u1")])).body).toMatchObject({ exposures: 0, conversions: 0 });
    expect((await results(id)).groups.treatment.users).toBe(0);
  });

  it("never stores the application's user keys, only a per-experiment hash", async () => {
    const id = await running();
    const secretish = "customer-4417@parcels.example";
    await events(devKey, [exposure(secretish, true), conversion(secretish)]);
    const rows = [...(await prisma.experimentExposure.findMany()), ...(await prisma.experimentConversion.findMany())];
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(secretish);
    expect(JSON.stringify(rows)).not.toContain("4417");
    expect(rows[0]!.userHash).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.stringify(await results(id))).not.toContain(secretish);
  });

  it("requires an API key (a user token is not accepted) and validates the batch", async () => {
    await running();
    expect((await request(app).post("/sdk/v1/events").send({ events: [exposure("u", true)] })).status).toBe(401);
    expect((await request(app).post("/sdk/v1/events").set("Authorization", member.auth).send({ events: [exposure("u", true)] })).status).toBe(401);
    expect((await events(devKey, [])).status).toBe(400);
    expect((await events(devKey, [{ type: "purchase", userKey: "u" }])).status).toBe(400);
    expect((await events(devKey, [{ ...exposure("u", true), value: "yes" }])).status).toBe(400);
    expect((await events(devKey, [{ ...conversion("u"), extra: 1 }])).status).toBe(400);
    expect((await events(devKey, Array.from({ length: 501 }, (_, i) => exposure(`u${i}`, true)))).status).toBe(400);
    expect((await events(devKey, Array.from({ length: 500 }, (_, i) => exposure(`u${i}`, i % 2 === 0)))).body.exposures).toBe(500);
  });
});

describe("results", () => {
  /** 300 users in each group; `rate` of each group converts. */
  async function feed(controlConversions: number, treatmentConversions: number, controlUsers = 300, treatmentUsers = 300) {
    const list: object[] = [];
    for (let i = 0; i < controlUsers; i++) list.push(exposure(`c${i}`, false), ...(i < controlConversions ? [conversion(`c${i}`)] : []));
    for (let i = 0; i < treatmentUsers; i++) list.push(exposure(`t${i}`, true), ...(i < treatmentConversions ? [conversion(`t${i}`)] : []));
    for (let i = 0; i < list.length; i += 500) expect((await events(devKey, list.slice(i, i + 500))).status).toBe(202);
  }

  it("reports counts and the same analysis as packages/core on those counts", async () => {
    const id = await running();
    await feed(30, 60);
    const body = await results(id);
    expect(body.groups).toEqual({ control: { users: 300, conversions: 30 }, treatment: { users: 300, conversions: 60 } });
    const expected = analyzeExperiment({ users: 300, conversions: 30 }, { users: 300, conversions: 60 }, { expectedTreatmentShare: 0.5 });
    expect(body.analysis).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(body.analysis.verdict).toBe("treatment_better");
    expect(body.sampleRatioChecked).toBe(true);
    expect(body.flagState).toEqual({ enabled: true, rolloutPercentage: 50, ruleCount: 0 });
  });

  it("says there is not enough data instead of guessing", async () => {
    const id = await running();
    await events(devKey, [exposure("u1", true), conversion("u1"), exposure("u2", false)]);
    const body = await results(id);
    expect(body.analysis).toMatchObject({ verdict: "not_enough_data", pValue: null, zScore: null });
  });

  it("flags a split that does not match the rollout", async () => {
    const id = await running(); // rollout is 50%
    await feed(30, 20, 600, 200); // but three quarters of users were reported in control
    const body = await results(id);
    expect(body.analysis.sampleRatio.mismatch).toBe(true);
    expect(body.analysis.sampleRatio.observedTreatmentShare).toBeCloseTo(0.25, 10);
  });

  it("skips the split check when targeting rules decide who gets the flag", async () => {
    await setFlag(devId, { enabled: true, rolloutPercentage: 50, rules: [{ conditions: [{ attribute: "plan", operator: "equals", value: "pro" }], rolloutPercentage: 100 }] });
    const id = (await create()).body.id;
    await as(member).post(`${base()}/${id}/start`);
    await feed(30, 20, 600, 200);
    const body = await results(id);
    expect(body.sampleRatioChecked).toBe(false);
    expect(body.analysis.sampleRatio.mismatch).toBe(false);
    expect(body.analysis.verdict).not.toBe("not_enough_data"); // the comparison itself is still made
    expect(body.flagState.ruleCount).toBe(1);
  });

  it("an empty draft has no analysis to give", async () => {
    await setFlag(devId, { enabled: true, rolloutPercentage: 100 });
    const body = await results((await create()).body.id);
    expect(body.analysis).toBeNull();
    expect(body.sampleRatioChecked).toBe(false);
  });
});

describe("clean-up and history", () => {
  it("deleting an experiment removes its rows; deleting the flag removes its experiments", async () => {
    const id = await running();
    await events(devKey, [exposure("u1", true), conversion("u1")]);
    expect((await as(admin).del(`${base()}/${id}`)).status).toBe(204);
    expect(await prisma.experimentExposure.count()).toBe(0);
    expect(await prisma.experimentConversion.count()).toBe(0);

    const again = await running();
    await events(devKey, [exposure("u1", true)]);
    await as(admin).del(`/workspaces/${wsId}/projects/${projectId}/flags/${flagId}`).expect(204);
    expect((await as(viewer).get(`${base()}/${again}`)).status).toBe(404);
    expect(await prisma.experimentExposure.count()).toBe(0);
  });

  it("writes an audit entry for create, start, stop and delete", async () => {
    const id = await running();
    await as(member).post(`${base()}/${id}/stop`);
    await as(admin).del(`${base()}/${id}`);
    const entries = (await as(owner).get(`/workspaces/${wsId}/audit-log`)).body.entries.filter((e: { entityType: string }) => e.entityType === "experiment");
    expect(entries.map((e: { action: string }) => e.action)).toEqual(["experiment.deleted", "experiment.stopped", "experiment.started", "experiment.created"]);
    expect(entries[3].metadata).toMatchObject({ name: "One-tap checkout", key: "checkout", environmentKey: "dev", metricKey: "checkout-completed" });
  });
});
