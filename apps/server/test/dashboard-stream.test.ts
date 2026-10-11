import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealtime } from "../src/realtime/index.js";
import { makeApp, prisma, registerUser, resetDb, testConfig, type TestUser } from "./helpers.js";
import { listen, openStream, sleep, type OpenStream } from "./sse-helper.js";

const realtime = createRealtime(prisma, testConfig);
const app = makeApp({ realtime });
let url: string;
let stopServer: () => Promise<void>;

let owner: TestUser;
let wsId: string;
let projectId: string;
let flagId: string;
let envIds: Record<string, string>;
const open: OpenStream[] = [];

beforeAll(async () => {
  const s = await listen(app);
  url = s.url;
  stopServer = s.stop;
});
afterAll(async () => {
  await realtime.close();
  await stopServer();
});
afterEach(() => open.splice(0).forEach((s) => s.close()));

const token = (user: TestUser) => user.auth.replace("Bearer ", "");
const as = (user: TestUser) => ({
  post: (path: string, body?: object) => request(app).post(path).set("Authorization", user.auth).send(body),
  put: (path: string, body?: object) => request(app).put(path).set("Authorization", user.auth).send(body),
  delete: (path: string) => request(app).delete(path).set("Authorization", user.auth),
});
const streamPath = (ws = wsId, project = projectId) => `/workspaces/${ws}/projects/${project}/stream`;
const stream = async (accessToken?: string, path = streamPath()) => {
  const s = await openStream(`${url}${path}`, accessToken);
  open.push(s);
  return s;
};
const data = (message: { data?: string }) => JSON.parse(message.data ?? "{}");
const until = (fn: () => void | Promise<void>, timeout = 3000) => vi.waitFor(fn, { timeout, interval: 10 });
const toggle = (envKey: string, enabled: boolean) =>
  as(owner).put(`/workspaces/${wsId}/projects/${projectId}/flags/${flagId}/environments/${envIds[envKey]}`, { enabled });

beforeEach(async () => {
  await resetDb();
  owner = await registerUser(app, "owner@example.com");
  wsId = (await as(owner).post("/workspaces", { name: "Acme", slug: "acme" })).body.id;
  const project = (await as(owner).post(`/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = project.id;
  envIds = Object.fromEntries(project.environments.map((e: { key: string; id: string }) => [e.key, e.id]));
  flagId = (await as(owner).post(`/workspaces/${wsId}/projects/${projectId}/flags`, { key: "checkout", name: "C" })).body.id;
});

describe("who may listen", () => {
  it("rejects a request without a token, and an API key is not a user token", async () => {
    expect((await stream()).status).toBe(401);
    const key = (await as(owner).post(`/workspaces/${wsId}/projects/${projectId}/environments/${envIds["dev"]}/api-keys`, { name: "k" })).body.key;
    expect((await stream(key)).status).toBe(401);
  });

  it("hides the stream from people outside the workspace (404, not 403)", async () => {
    const stranger = await registerUser(app, "stranger@example.com");
    const s = await stream(token(stranger));
    expect(s.status).toBe(404);
    expect(realtime.dashboard.connectionCount).toBe(0);
  });

  it("does not let a member of one workspace listen to another workspace's project", async () => {
    const other = await registerUser(app, "other@example.com");
    const otherWs = (await as(other).post("/workspaces", { name: "Other", slug: "other" })).body.id;
    // Their own workspace id with OUR project id: the project "does not exist" there.
    const s = await stream(token(other), streamPath(otherWs, projectId));
    expect(s.status).toBe(404);
    expect(await (await fetch(`${url}${streamPath(otherWs, projectId)}`, { headers: { Authorization: other.auth } })).json()).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });
  });

  it("lets a viewer listen", async () => {
    const viewer = await registerUser(app, "viewer@example.com");
    await as(owner).post(`/workspaces/${wsId}/members`, { email: "viewer@example.com", role: "VIEWER" });
    const s = await stream(token(viewer));
    expect(s.status).toBe(200);
    expect((await s.nextEvent()).event).toBe("hello");
  });
});

describe("what it says", () => {
  it("starts with a hello listing every environment and its current version", async () => {
    const s = await stream(token(owner));
    expect(s.status).toBe(200);
    expect(s.headers.get("content-type")).toContain("text/event-stream");
    const hello = await s.nextEvent();
    expect(hello.event).toBe("hello");
    const environments = data(hello).environments as { environmentId: string; key: string; version: number }[];
    expect(environments.map((e) => e.key)).toEqual(["dev", "staging", "prod"]);
    const stored = await prisma.environment.findMany({ where: { projectId } });
    for (const e of environments) expect(e.version).toBe(stored.find((row) => row.id === e.environmentId)!.configVersion);
  });

  it("announces a toggle for the environment that changed, and only that one", async () => {
    const s = await stream(token(owner));
    const hello = data(await s.nextEvent()).environments as { environmentId: string; version: number }[];
    const before = hello.find((e) => e.environmentId === envIds["prod"])!.version;

    await toggle("prod", true);
    const change = await s.nextEvent();
    expect(change.event).toBe("change");
    expect(data(change)).toEqual({ environmentId: envIds["prod"], version: before + 1 });

    await sleep(100);
    expect(s.events()).toHaveLength(2); // hello + one change: dev and staging said nothing
  });

  it("announces a new flag for every environment (it appears in all of them)", async () => {
    const s = await stream(token(owner));
    await s.nextEvent();
    await as(owner).post(`/workspaces/${wsId}/projects/${projectId}/flags`, { key: "second", name: "S" });
    await until(() => expect(s.events().filter((m) => m.event === "change")).toHaveLength(3));
    expect(new Set(s.events().slice(1).map((m) => data(m).environmentId))).toEqual(new Set(Object.values(envIds)));
  });

  it("stays silent about other projects, even in the same workspace", async () => {
    const second = (await as(owner).post(`/workspaces/${wsId}/projects`, { name: "Api", key: "api" })).body;
    const otherFlag = (await as(owner).post(`/workspaces/${wsId}/projects/${second.id}/flags`, { key: "x", name: "X" })).body.id;
    const s = await stream(token(owner));
    await s.nextEvent();
    await as(owner).put(`/workspaces/${wsId}/projects/${second.id}/flags/${otherFlag}/environments/${second.environments[0].id}`, { enabled: true });
    await sleep(150);
    expect(s.events()).toHaveLength(1);
  });

  it("carries only ids and version numbers, never flag data", async () => {
    const s = await stream(token(owner));
    await s.nextEvent();
    await toggle("dev", true);
    const change = await s.nextEvent();
    expect(Object.keys(data(change)).sort()).toEqual(["environmentId", "version"]);
    expect(JSON.stringify(s.events())).not.toContain("checkout");
  });

  it("sends heartbeats so proxies keep the connection open", async () => {
    const s = await stream(token(owner));
    await until(() => expect(s.messages.some((m) => m.comment === "ping")).toBe(true));
  });
});

describe("access does not outlive its grounds", () => {
  it("ends the stream when the access token that opened it expires", async () => {
    const shortLived = jwt.sign({}, testConfig.JWT_ACCESS_SECRET, { algorithm: "HS256", subject: owner.id, expiresIn: 1 });
    const s = await stream(shortLived);
    expect(s.status).toBe(200);
    await s.nextEvent();
    const opened = Date.now();
    await s.closed;
    expect(Date.now() - opened).toBeLessThan(2500);
    await until(() => expect(realtime.dashboard.connectionCount).toBe(0));
  });

  it("ends the stream of someone removed from the workspace", async () => {
    const member = await registerUser(app, "member@example.com");
    await as(owner).post(`/workspaces/${wsId}/members`, { email: "member@example.com", role: "MEMBER" });
    const s = await stream(token(member));
    await s.nextEvent();

    await as(owner).delete(`/workspaces/${wsId}/members/${member.id}`).expect(204);
    await s.closed; // within one re-check interval (300ms in tests)
    expect(realtime.dashboard.connectionCount).toBe(0);
  });

  it("ends the stream when the project is deleted", async () => {
    const s = await stream(token(owner));
    await s.nextEvent();
    await as(owner).delete(`/workspaces/${wsId}/projects/${projectId}`).expect(204);
    await s.closed;
  });

  it("caps the number of streams one person can hold open", async () => {
    for (let i = 0; i < 10; i++) expect((await stream(token(owner))).status).toBe(200);
    const eleventh = await stream(token(owner));
    expect(eleventh.status).toBe(429);
    // Closing one frees a slot.
    open[0]!.close();
    await until(() => expect(realtime.dashboard.connectionCount).toBe(9));
    expect((await stream(token(owner))).status).toBe(200);
  });

  it("is ended by shutdown, so the server can stop", async () => {
    const own = createRealtime(prisma, testConfig);
    const server = await listen(makeApp({ realtime: own }));
    const s = await openStream(`${server.url}${streamPath()}`, token(owner));
    await s.nextEvent();
    await own.close();
    await s.closed;
    expect(own.dashboard.connectionCount).toBe(0);
    await server.stop();
  });
});
