import { FlagForgeClient } from "@flagforge/sdk";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApp, registerUser, resetDb, type TestUser } from "./helpers.js";

// The real SDK against the real app, over a real socket and the real (test) database.
const app = makeApp();
let server: Server;
let baseUrl: string;

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
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => clients.splice(0).forEach((c) => c.close()));

const post = (url: string, body: object = {}) => request(app).post(url).set("Authorization", owner.auth).send(body);
const put = (url: string, body: object) => request(app).put(url).set("Authorization", owner.auth).send(body);
const configure = (envId: string, body: object) =>
  put(`/workspaces/${wsId}/projects/${projectId}/flags/${flagId}/environments/${envId}`, body);
const makeClient = (apiKey: string) => {
  const client = new FlagForgeClient({ apiKey, baseUrl, pollIntervalMs: 0, requestTimeoutMs: 3000 });
  clients.push(client);
  return client;
};

beforeEach(async () => {
  await resetDb();
  owner = await registerUser(app, "owner@example.com");
  wsId = (await post("/workspaces", { name: "Acme", slug: "acme" })).body.id;
  const project = (await post(`/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = project.id;
  devId = project.environments.find((e: { key: string }) => e.key === "dev").id;
  prodId = project.environments.find((e: { key: string }) => e.key === "prod").id;
  flagId = (await post(`/workspaces/${wsId}/projects/${projectId}/flags`, { key: "checkout", name: "Checkout" })).body.id;
  const mk = async (envId: string) =>
    (await post(`/workspaces/${wsId}/projects/${projectId}/environments/${envId}/api-keys`, { name: "sdk" })).body.key as string;
  devKey = await mk(devId);
  prodKey = await mk(prodId);
});

describe("SDK against the real server", () => {
  it("loads the config and follows changes made through the management API", async () => {
    const client = makeClient(devKey);
    expect(await client.init()).toEqual({ ready: true, source: "network" });
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(false);

    await configure(devId, { enabled: true });
    expect(await client.refresh()).toBe(true);
    expect(client.evaluate("checkout", { key: "u1" })).toEqual({ value: true, reason: "FALLTHROUGH" });

    await configure(devId, { enabled: false });
    await client.refresh();
    expect(client.evaluate("checkout", { key: "u1" })).toEqual({ value: false, reason: "OFF" });
  });

  it("uses real ETags: unchanged config gives a 304 and no update event", async () => {
    const client = makeClient(devKey);
    await client.init();
    const onUpdate = vi.fn();
    client.on("update", onUpdate);

    const first = await fetch(`${baseUrl}/sdk/v1/flags`, { headers: { Authorization: `Bearer ${devKey}` } });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await fetch(`${baseUrl}/sdk/v1/flags`, { headers: { Authorization: `Bearer ${devKey}`, "If-None-Match": etag! } });
    expect(again.status).toBe(304);

    expect(await client.refresh()).toBe(true);
    expect(onUpdate).not.toHaveBeenCalled();

    await configure(devId, { enabled: true });
    await client.refresh();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("a change in another environment does not disturb this environment's client", async () => {
    const dev = makeClient(devKey);
    await dev.init();
    const onUpdate = vi.fn();
    dev.on("update", onUpdate);
    await configure(prodId, { enabled: true, rolloutPercentage: 10 });
    await dev.refresh();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(dev.isEnabled("checkout", { key: "u1" })).toBe(false);
  });

  it("local SDK decisions equal the server's own /evaluate for rules and rollouts", async () => {
    await configure(devId, {
      enabled: true,
      rolloutPercentage: 35,
      rules: [
        { id: "vip", conditions: [{ attribute: "tier", operator: "in", value: ["gold", "platinum"] }], rolloutPercentage: 80 },
        { id: "adults", conditions: [{ attribute: "age", operator: "gte", value: 65 }], rolloutPercentage: 100 },
      ],
    });
    const client = makeClient(devKey);
    await client.init();
    const tiers = ["gold", "silver", "platinum", undefined];
    for (let i = 0; i < 50; i++) {
      const context = { key: `customer-${i}`, attributes: { tier: tiers[i % 4], age: 20 + (i % 60) } as Record<string, string | number> };
      const local = client.evaluate("checkout", context);
      const remote = (await request(app).post("/sdk/v1/evaluate").set("Authorization", `Bearer ${devKey}`).send({ flagKey: "checkout", context })).body;
      const { flagKey: _flagKey, ...remoteResult } = remote;
      expect(local).toEqual(remoteResult);
    }
  });

  it("each environment key sees its own state", async () => {
    await configure(devId, { enabled: true });
    const dev = makeClient(devKey);
    const prod = makeClient(prodKey);
    await Promise.all([dev.init(), prod.init()]);
    expect(dev.isEnabled("checkout", { key: "u1" })).toBe(true);
    expect(prod.isEnabled("checkout", { key: "u1" })).toBe(false);
  });

  it("goes fatal when the key is revoked, but keeps serving the last config", async () => {
    await configure(devId, { enabled: true });
    const client = makeClient(devKey);
    await client.init();
    const keys = (await request(app).get(`/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys`).set("Authorization", owner.auth)).body.apiKeys;
    await request(app).delete(`/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys/${keys[0].id}`).set("Authorization", owner.auth);

    expect(await client.refresh()).toBe(false);
    expect(client.status.fatal).toBe(true);
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(true);
  });

  it("a made-up key never becomes ready", async () => {
    const client = makeClient("ff_does_not_exist_000000000000000");
    expect(await client.init()).toEqual({ ready: false, source: "none" });
    expect(client.status.fatal).toBe(true);
    expect(client.isEnabled("checkout", { key: "u1" }, true)).toBe(true); // falls back to the caller's default
  });
});
