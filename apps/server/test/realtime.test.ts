import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { InMemoryEventBus } from "../src/realtime/bus.js";
import { createRealtime } from "../src/realtime/index.js";
import { StreamManager } from "../src/realtime/streams.js";
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
let devId: string;
let prodId: string;
let devKey: string;
let prodKey: string;
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

const api = (method: "post" | "put" | "patch" | "delete", path: string, body?: object, a = app) => {
  const r = request(a)[method](path).set("Authorization", owner.auth);
  return body ? r.send(body) : r;
};
const configure = (envId: string, body: object) =>
  api("put", `/workspaces/${wsId}/projects/${projectId}/flags/${flagId}/environments/${envId}`, body);
const stream = async (key: string, base = url) => {
  const s = await openStream(`${base}/sdk/v1/stream`, key);
  open.push(s);
  return s;
};
const until = (fn: () => void | Promise<void>, timeout = 3000) => vi.waitFor(fn, { timeout, interval: 10 });
/** Versions of the change events only (excludes hello). */
const changes = (s: OpenStream) => s.events().filter((m) => m.event === "change").map((m) => JSON.parse(m.data!).version as number);

beforeEach(async () => {
  await resetDb();
  owner = await registerUser(app, "owner@example.com");
  wsId = (await api("post", "/workspaces", { name: "Acme", slug: "acme" })).body.id;
  const project = (await api("post", `/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = project.id;
  devId = project.environments.find((e: { key: string }) => e.key === "dev").id;
  prodId = project.environments.find((e: { key: string }) => e.key === "prod").id;
  const mk = async (envId: string) =>
    (await api("post", `/workspaces/${wsId}/projects/${projectId}/environments/${envId}/api-keys`, { name: "k" })).body.key as string;
  devKey = await mk(devId);
  prodKey = await mk(prodId);
  flagId = (await api("post", `/workspaces/${wsId}/projects/${projectId}/flags`, { key: "checkout", name: "C" })).body.id;
});

describe("stream basics", () => {
  it("opens an SSE stream and starts with a hello carrying the current version", async () => {
    const s = await stream(devKey);
    expect(s.status).toBe(200);
    expect(s.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(s.headers.get("cache-control")).toMatch(/no-cache/);
    const hello = await s.nextEvent();
    expect(hello.event).toBe("hello");
    const { version } = JSON.parse(hello.data!);
    expect(hello.id).toBe(String(version));
    expect(version).toBe(1); // creating the flag bumped the environment once
    const flags = await request(app).get("/sdk/v1/flags").set("Authorization", `Bearer ${devKey}`);
    expect(flags.body.version).toBe(version);
    expect(s.messages[0]!.retry).toBe("3000");
  });

  it("sends heartbeat comments so idle connections are not closed by proxies", async () => {
    const s = await stream(devKey);
    await until(() => expect(s.messages.some((m) => m.comment === "ping")).toBe(true));
  });

  it("requires a valid API key", async () => {
    for (const key of [undefined, "garbage", "ff_unknown_key", owner.auth.replace("Bearer ", "")]) {
      const res = await fetch(`${url}/sdk/v1/stream`, key ? { headers: { Authorization: `Bearer ${key}` } } : {});
      expect(res.status, String(key)).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_API_KEY");
    }
  });

  it("cleans up completely when clients disconnect", async () => {
    const a = await stream(devKey);
    const b = await stream(prodKey);
    await a.nextEvent();
    await b.nextEvent();
    expect(realtime.streams.connectionCount).toBe(2);
    a.close();
    b.close();
    await until(() => expect(realtime.streams.connectionCount).toBe(0));
  });
});

describe("versions and events", () => {
  it("pushes a change event with the new version after each real change", async () => {
    const s = await stream(devKey);
    await s.nextEvent(); // hello(1)
    await configure(devId, { enabled: true });
    const first = await s.nextEvent();
    expect(first.event).toBe("change");
    expect(JSON.parse(first.data!).version).toBe(2);
    await configure(devId, { rolloutPercentage: 40 });
    expect(JSON.parse((await s.nextEvent()).data!).version).toBe(3);
    const flags = await request(app).get("/sdk/v1/flags").set("Authorization", `Bearer ${devKey}`);
    expect(flags.body.version).toBe(3);
  });

  it("the event arrives only after the change is committed (a refetch sees it)", async () => {
    const s = await stream(devKey);
    await s.nextEvent();
    await configure(devId, { enabled: true });
    await s.nextEvent();
    const flags = await request(app).get("/sdk/v1/flags").set("Authorization", `Bearer ${devKey}`);
    expect(flags.body.flags[0].enabled).toBe(true);
  });

  it("bumps once for a combined update (enabled + rules + rollout in one call)", async () => {
    const s = await stream(devKey);
    await s.nextEvent();
    await configure(devId, {
      enabled: true,
      rolloutPercentage: 10,
      rules: [{ conditions: [{ attribute: "plan", operator: "equals", value: "pro" }] }],
    });
    await s.nextEvent();
    await sleep(200);
    expect(changes(s)).toEqual([2]);
  });

  it("does not notify or bump for a no-op save", async () => {
    await configure(devId, { enabled: true, rolloutPercentage: 40 });
    const s = await stream(devKey);
    const hello = JSON.parse((await s.nextEvent()).data!).version;
    await configure(devId, { enabled: true, rolloutPercentage: 40 });
    await sleep(250);
    expect(changes(s)).toEqual([]);
    const env = await prisma.environment.findUniqueOrThrow({ where: { id: devId } });
    expect(env.configVersion).toBe(hello);
  });

  it("only notifies the environment that changed", async () => {
    const dev = await stream(devKey);
    const prod = await stream(prodKey);
    await dev.nextEvent();
    await prod.nextEvent();
    await configure(prodId, { enabled: true });
    expect(JSON.parse((await prod.nextEvent()).data!).version).toBe(2);
    await sleep(250);
    expect(changes(dev)).toEqual([]);
  });

  it("creating or deleting a flag notifies every environment of the project; renaming does not", async () => {
    const dev = await stream(devKey);
    const prod = await stream(prodKey);
    await dev.nextEvent();
    await prod.nextEvent();

    await api("patch", `/workspaces/${wsId}/projects/${projectId}/flags/${flagId}`, { name: "Renamed" });
    await sleep(250);
    expect(changes(dev)).toEqual([]);

    const created = await api("post", `/workspaces/${wsId}/projects/${projectId}/flags`, { key: "second", name: "Second" });
    await until(() => expect([changes(dev), changes(prod)]).toEqual([[2], [2]]));

    await api("delete", `/workspaces/${wsId}/projects/${projectId}/flags/${created.body.id}`);
    await until(() => expect([changes(dev), changes(prod)]).toEqual([[2, 3], [2, 3]]));
  });

  it("never lets one tenant hear another tenant's changes", async () => {
    const other = await registerUser(app, "other@example.com");
    const otherWs = (await request(app).post("/workspaces").set("Authorization", other.auth).send({ name: "O", slug: "other-co" })).body.id;
    const otherProject = (await request(app).post(`/workspaces/${otherWs}/projects`).set("Authorization", other.auth).send({ name: "P", key: "pp" })).body;
    const otherEnv = otherProject.environments[0].id;
    const otherKey = (await request(app).post(`/workspaces/${otherWs}/projects/${otherProject.id}/environments/${otherEnv}/api-keys`).set("Authorization", other.auth).send({ name: "k" })).body.key;

    const mine = await stream(devKey);
    const theirs = await stream(otherKey);
    await mine.nextEvent();
    await theirs.nextEvent();
    await configure(devId, { enabled: true });
    await mine.nextEvent();
    await sleep(250);
    expect(changes(theirs)).toEqual([]);
  });
});

describe("closing streams", () => {
  it("closes a key's streams immediately when the key is revoked (event-driven, not just polling)", async () => {
    const rt = createRealtime(prisma, { ...testConfig, SSE_REVALIDATE_MS: 600_000 }); // revalidation can't be the cause
    const app2 = makeApp({ realtime: rt });
    const server2 = await listen(app2);
    try {
      const s = await openStream(`${server2.url}/sdk/v1/stream`, devKey);
      open.push(s);
      await s.nextEvent();
      const list = await request(app2).get(`/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys`).set("Authorization", owner.auth);
      const started = Date.now();
      await request(app2).delete(`/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys/${list.body.apiKeys[0].id}`).set("Authorization", owner.auth);
      await Promise.race([s.closed, sleep(1500).then(() => Promise.reject(new Error("stream not closed")))]);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(rt.streams.connectionCount).toBe(0);
    } finally {
      await rt.close();
      await server2.stop();
    }
  });

  it("drops streams whose key or environment disappeared without an event (periodic revalidation)", async () => {
    const s = await stream(devKey);
    await s.nextEvent();
    await api("delete", `/workspaces/${wsId}/projects/${projectId}/environments/${devId}`); // cascades the key away
    await Promise.race([s.closed, sleep(2500).then(() => Promise.reject(new Error("stream not closed")))]);
    await until(() => expect(realtime.streams.connectionCount).toBe(0));
  });

  it("a revoked key cannot open a new stream", async () => {
    const list = await api("post", `/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys`, { name: "extra" });
    await api("delete", `/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys/${list.body.id}`);
    const res = await fetch(`${url}/sdk/v1/stream`, { headers: { Authorization: `Bearer ${list.body.key}` } });
    expect(res.status).toBe(401);
  });

  it("ends every stream on shutdown so server.close() cannot hang", async () => {
    const rt = createRealtime(prisma, testConfig);
    const app2 = makeApp({ realtime: rt });
    const server2 = await listen(app2);
    try {
      const a = await openStream(`${server2.url}/sdk/v1/stream`, devKey);
      const b = await openStream(`${server2.url}/sdk/v1/stream`, prodKey);
      open.push(a, b);
      await a.nextEvent();
      await b.nextEvent();
      await rt.close();
      await Promise.race([Promise.all([a.closed, b.closed]), sleep(1500).then(() => Promise.reject(new Error("not closed")))]);
      expect(rt.streams.connectionCount).toBe(0);
    } finally {
      await server2.stop();
    }
  });
});

describe("limits", () => {
  it("caps open streams per key (429) and frees the slot when one closes", async () => {
    const streams = [await stream(devKey), await stream(devKey), await stream(devKey)]; // limit is 3 in tests
    for (const s of streams) await s.nextEvent();
    const rejected = await fetch(`${url}/sdk/v1/stream`, { headers: { Authorization: `Bearer ${devKey}` } });
    expect(rejected.status).toBe(429);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe("TOO_MANY_STREAMS");
    // another key is unaffected
    const other = await stream(prodKey);
    expect((await other.nextEvent()).event).toBe("hello");

    streams[0]!.close();
    await until(() => expect(realtime.streams.connectionCount).toBe(3));
    const again = await stream(devKey);
    expect(again.status).toBe(200);
  });

  it("caps total streams", async () => {
    const rt = createRealtime(prisma, { ...testConfig, SSE_MAX_CONNECTIONS: 2 });
    const app2 = makeApp({ realtime: rt });
    const server2 = await listen(app2);
    try {
      for (const key of [devKey, prodKey]) {
        const s = await openStream(`${server2.url}/sdk/v1/stream`, key);
        open.push(s);
        await s.nextEvent();
      }
      const res = await fetch(`${server2.url}/sdk/v1/stream`, { headers: { Authorization: `Bearer ${devKey}` } });
      expect(res.status).toBe(429);
    } finally {
      await rt.close();
      await server2.stop();
    }
  });
});

describe("subscribe-before-read ordering (no lost updates around connect)", () => {
  async function harness(version: number, delayMs: number) {
    const bus = new InMemoryEventBus();
    const fakePrisma = {
      environment: { findFirst: async () => { await sleep(delayMs); return { configVersion: version }; } },
      apiKey: { findFirst: async () => ({ id: "k1" }) },
    } as unknown as PrismaClient;
    const manager = new StreamManager(fakePrisma, bus, { heartbeatMs: 60_000, revalidateMs: 60_000, maxConnections: 10, maxPerKey: 10 });
    const mini = express();
    mini.get("/s", (req, res) => {
      req.sdk = { apiKeyId: "k1", workspaceId: "w1", projectId: "p1", environmentId: "e1", environmentKey: "dev" };
      void manager.handle(req, res).catch(() => res.end());
    });
    const server = await listen(mini);
    return { bus, manager, server };
  }

  it("delivers a change that lands while the hello is still being prepared, and drops stale ones", async () => {
    const { bus, server } = await harness(5, 150);
    try {
      const s = await openStream(`${server.url}/s`);
      open.push(s);
      // These arrive during the 150ms "database read": 6 is newer than the hello (5), 4 and 5 are not.
      await bus.publish("env:e1", { type: "config", environmentId: "e1", version: 6 });
      await bus.publish("env:e1", { type: "config", environmentId: "e1", version: 4 });
      await bus.publish("env:e1", { type: "config", environmentId: "e1", version: 5 });
      await until(() => expect(s.versions()).toEqual([5, 6]));
      expect(s.events().map((m) => m.event)).toEqual(["hello", "change"]);
      await bus.publish("env:e1", { type: "config", environmentId: "e1", version: 7 });
      await until(() => expect(s.versions()).toEqual([5, 6, 7]));
    } finally {
      await server.stop();
    }
  });

  it("releases its bus subscriptions when the client leaves", async () => {
    const { bus, manager, server } = await harness(1, 0);
    try {
      const s = await openStream(`${server.url}/s`);
      await s.nextEvent();
      expect(bus.topicCount).toBe(2);
      s.close();
      await until(() => expect(manager.connectionCount).toBe(0));
      expect(bus.topicCount).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

describe("event bus", () => {
  it("isolates a throwing subscriber and supports unsubscribe", async () => {
    const bus = new InMemoryEventBus();
    const seen: number[] = [];
    bus.subscribe("t", () => {
      throw new Error("boom");
    });
    const off = bus.subscribe("t", (m) => void seen.push(m.type === "config" ? m.version : -1));
    await bus.publish("t", { type: "config", environmentId: "e", version: 1 });
    off();
    await bus.publish("t", { type: "config", environmentId: "e", version: 2 });
    expect(seen).toEqual([1]);
  });
});

describe("degraded notifications (the bus lost contact with other instances)", () => {
  /** A bus whose health the test controls. */
  class ControlledBus extends InMemoryEventBus {
    healthy = true;
    #handlers = new Set<(healthy: boolean) => void>();
    override isHealthy() {
      return this.healthy;
    }
    override onHealthChange(handler: (healthy: boolean) => void) {
      this.#handlers.add(handler);
      return () => this.#handlers.delete(handler);
    }
    setHealth(healthy: boolean) {
      this.healthy = healthy;
      for (const h of this.#handlers) h(healthy);
    }
  }

  async function harness(version: number) {
    const bus = new ControlledBus();
    const fakePrisma = {
      environment: { findFirst: async () => ({ configVersion: version }) },
      apiKey: { findFirst: async () => ({ id: "k1" }) },
    } as unknown as PrismaClient;
    const manager = new StreamManager(fakePrisma, bus, { heartbeatMs: 60_000, revalidateMs: 60_000, maxConnections: 10, maxPerKey: 10 });
    const mini = express();
    mini.get("/s", (req, res) => {
      req.sdk = { apiKeyId: "k1", workspaceId: "w1", projectId: "p1", environmentId: "e1", environmentKey: "dev" };
      void manager.handle(req, res).catch(() => res.end());
    });
    return { bus, manager, server: await listen(mini) };
  }
  const names = (s: OpenStream) => s.events().map((m) => m.event);

  it("tells connected SDKs when the feed breaks, and re-announces the version when it recovers", async () => {
    const { bus, server } = await harness(7);
    try {
      const s = await openStream(`${server.url}/s`);
      open.push(s);
      await s.nextEvent();
      expect(names(s)).toEqual(["hello"]);

      bus.setHealth(false);
      await until(() => expect(names(s)).toEqual(["hello", "degraded"]));
      expect(JSON.parse(s.events()[1]!.data!)).toEqual({ degraded: true });
      expect(s.events()[1]!.id).toBeUndefined(); // not a versioned event

      bus.setHealth(true);
      await until(() => expect(names(s)).toEqual(["hello", "degraded", "hello"]));
      expect(s.versions().filter((v) => v !== undefined)).toEqual([7, 7]);
    } finally {
      await server.stop();
    }
  });

  it("flags a stream that connects while the feed is already broken", async () => {
    const { bus, server } = await harness(3);
    try {
      bus.healthy = false;
      const s = await openStream(`${server.url}/s`);
      open.push(s);
      await until(() => expect(names(s)).toEqual(["hello", "degraded"]));
    } finally {
      await server.stop();
    }
  });

  it("does not announce anything when health does not change, and stops listening after dispose", async () => {
    const { bus, manager, server } = await harness(1);
    try {
      const s = await openStream(`${server.url}/s`);
      open.push(s);
      await s.nextEvent();
      manager.dispose();
      bus.setHealth(false);
      await sleep(150);
      expect(names(s)).toEqual(["hello"]);
    } finally {
      await server.stop();
    }
  });
});
