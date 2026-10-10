import { FlagForgeClient, type FlagForgeError } from "@flagforge/sdk";
import { writeFileSync } from "node:fs";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealtime } from "../src/realtime/index.js";
import { makeApp, prisma, registerUser, resetDb, testConfig, type TestUser } from "./helpers.js";
import { listen, sleep } from "./sse-helper.js";

// The real SDK, streaming from the real server over real sockets, backed by the real (test) database.
const realtime = createRealtime(prisma, testConfig);
const app = makeApp({ realtime });
let baseUrl: string;
let stopServer: () => Promise<void>;

let owner: TestUser;
let wsId: string;
let projectId: string;
let flagId: string;
let devId: string;
let prodId: string;
let devKey: string;
let prodKey: string;
const clients: FlagForgeClient[] = [];

beforeAll(async () => {
  const s = await listen(app);
  baseUrl = s.url;
  stopServer = s.stop;
});
afterAll(async () => {
  await realtime.close();
  await stopServer();
});
afterEach(() => clients.splice(0).forEach((c) => c.close()));

const api = (method: "post" | "put" | "patch" | "delete" | "get", path: string, body?: object) => {
  const r = request(app)[method](path).set("Authorization", owner.auth);
  return body ? r.send(body) : r;
};
const configure = (envId: string, body: object, flag = flagId) =>
  api("put", `/workspaces/${wsId}/projects/${projectId}/flags/${flag}/environments/${envId}`, body);
const makeClient = (apiKey: string, overrides: Record<string, unknown> = {}) => {
  const client = new FlagForgeClient({
    apiKey,
    baseUrl,
    pollIntervalMs: 0, // no polling at all: only the stream can deliver changes
    requestTimeoutMs: 3000,
    maxBackoffMs: 100,
    ...overrides,
  });
  clients.push(client);
  return client;
};
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 4000, interval: 10 });
const connected = (c: FlagForgeClient) => until(() => expect(c.status.stream).toBe("connected"));

beforeEach(async () => {
  await resetDb();
  owner = await registerUser(app, "owner@example.com");
  wsId = (await api("post", "/workspaces", { name: "Acme", slug: "acme" })).body.id;
  const project = (await api("post", `/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = project.id;
  devId = project.environments.find((e: { key: string }) => e.key === "dev").id;
  prodId = project.environments.find((e: { key: string }) => e.key === "prod").id;
  flagId = (await api("post", `/workspaces/${wsId}/projects/${projectId}/flags`, { key: "checkout", name: "C" })).body.id;
  const mk = async (envId: string) =>
    (await api("post", `/workspaces/${wsId}/projects/${projectId}/environments/${envId}/api-keys`, { name: "k" })).body.key as string;
  devKey = await mk(devId);
  prodKey = await mk(prodId);
});

describe("SDK streaming against the real server", () => {
  it("receives changes with no polling at all", async () => {
    const client = makeClient(devKey);
    expect((await client.init()).ready).toBe(true);
    await connected(client);
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(false);

    await configure(devId, { enabled: true });
    await until(() => expect(client.isEnabled("checkout", { key: "u1" })).toBe(true));
    await configure(devId, { enabled: false });
    await until(() => expect(client.isEnabled("checkout", { key: "u1" })).toBe(false));
    expect(client.status.version).toBe(3);
  });

  it("receives rule and rollout changes and evaluates them locally", async () => {
    const client = makeClient(devKey);
    await client.init();
    await connected(client);
    await configure(devId, {
      enabled: true,
      rolloutPercentage: 0,
      rules: [{ id: "pro", conditions: [{ attribute: "plan", operator: "equals", value: "pro" }] }],
    });
    await until(() => expect(client.evaluate("checkout", { key: "u1", attributes: { plan: "pro" } }).ruleId).toBe("pro"));
    expect(client.isEnabled("checkout", { key: "u1", attributes: { plan: "free" } })).toBe(false);
  });

  it("learns about newly created and deleted flags", async () => {
    const client = makeClient(devKey);
    await client.init();
    await connected(client);
    const created = await api("post", `/workspaces/${wsId}/projects/${projectId}/flags`, { key: "dark-mode", name: "D" });
    await until(() => expect(client.evaluate("dark-mode", { key: "u1" }).reason).toBe("OFF"));
    await api("delete", `/workspaces/${wsId}/projects/${projectId}/flags/${created.body.id}`);
    await until(() => expect(client.evaluate("dark-mode", { key: "u1" }).reason).toBe("FLAG_NOT_FOUND"));
  });

  it("each environment's client hears only its own environment's changes", async () => {
    const dev = makeClient(devKey);
    const prod = makeClient(prodKey);
    await Promise.all([dev.init(), prod.init()]);
    await Promise.all([connected(dev), connected(prod)]);
    const devVersion = dev.status.version;
    await configure(prodId, { enabled: true });
    await until(() => expect(prod.isEnabled("checkout", { key: "u1" })).toBe(true));
    await sleep(200);
    expect(dev.status.version).toBe(devVersion);
    expect(dev.isEnabled("checkout", { key: "u1" })).toBe(false);
  });

  it("reconnects after the server drops every stream, and catches up on changes made while disconnected", async () => {
    const client = makeClient(devKey);
    await client.init();
    await connected(client);

    realtime.streams.closeAll(); // like a deploy restarting the server
    await until(() => expect(client.status.stream).not.toBe("connected"));
    await configure(devId, { enabled: true }); // no stream is open to hear this
    await connected(client); // reconnected; the hello version is newer than ours
    await until(() => expect(client.isEnabled("checkout", { key: "u1" })).toBe(true));
  });

  it("is told to stop when its key is revoked: stream closes, reconnect gets 401, client goes fatal", async () => {
    const client = makeClient(devKey);
    const errors: FlagForgeError[] = [];
    client.on("error", (e) => errors.push(e));
    await client.init();
    await connected(client);
    await configure(devId, { enabled: true });
    await until(() => expect(client.isEnabled("checkout", { key: "u1" })).toBe(true));

    const keys = (await api("get", `/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys`)).body.apiKeys;
    await api("delete", `/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys/${keys[0].id}`);
    await until(() => expect(client.status.fatal).toBe(true));
    expect(errors.at(-1)!.fatal).toBe(true);
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(true); // keeps serving the last config
  });

  it("a client over the per-key stream limit keeps working through polling, without going fatal", async () => {
    const first = [makeClient(devKey), makeClient(devKey), makeClient(devKey)]; // limit is 3 in tests
    await Promise.all(first.map((c) => c.init()));
    await Promise.all(first.map(connected));

    const fourth = makeClient(devKey, { pollIntervalMs: 50 });
    const errors: FlagForgeError[] = [];
    fourth.on("error", (e) => errors.push(e));
    await fourth.init();
    await until(() => expect(errors.some((e) => e.status === 429)).toBe(true));
    expect(fourth.status.fatal).toBe(false);
    expect(fourth.status.stream).not.toBe("connected");

    await configure(devId, { enabled: true });
    await until(() => expect(fourth.isEnabled("checkout", { key: "u1" })).toBe(true)); // via polling fallback
  });

  it("measures real end-to-end propagation latency (API call to SDK decision) on this machine", async () => {
    const client = makeClient(devKey);
    await client.init();
    await connected(client);
    const samples: number[] = [];
    for (let i = 0; i < 25; i++) {
      const enable = i % 2 === 0;
      const started = performance.now();
      await configure(devId, { enabled: enable });
      await until(() => expect(client.isEnabled("checkout", { key: "u1" })).toBe(enable));
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const pct = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!;
    // Set LATENCY_OUT=<file> to record the numbers from a run (nothing is printed otherwise).
    if (process.env["LATENCY_OUT"]) {
      writeFileSync(
        process.env["LATENCY_OUT"],
        `API call -> SDK sees change, n=${samples.length}, same machine, includes the HTTP request itself: ` +
          `min=${samples[0]!.toFixed(1)}ms median=${pct(0.5).toFixed(1)}ms p90=${pct(0.9).toFixed(1)}ms max=${samples.at(-1)!.toFixed(1)}ms\n`,
      );
    }
    expect(pct(0.5)).toBeLessThan(500);
  });
});
