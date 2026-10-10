import { FlagForgeClient, type FlagForgeError } from "@flagforge/sdk";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealtime } from "../src/realtime/index.js";
import { createRedisServices } from "../src/redis/index.js";
import { makeApp, prisma, registerUser, resetDb, testConfig, testRedis, type TestUser } from "./helpers.js";
import { listen } from "./sse-helper.js";

// Two (or three) independent server instances: each has its own streams and event bus connections,
// and they share ONLY Postgres and Redis, exactly like two copies of the app behind a load balancer.
interface Instance {
  url: string;
  app: ReturnType<typeof makeApp>;
  redis: ReturnType<typeof createRedisServices>;
  stop(): Promise<void>;
}
async function startInstance(redisUrl = process.env["TEST_REDIS_URL"], { waitForRedis = true } = {}): Promise<Instance> {
  const redis = createRedisServices({ REDIS_URL: redisUrl, RATE_LIMIT_ENABLED: true });
  if (waitForRedis) await redis.waitUntilReady(3000);
  const realtime = createRealtime(prisma, testConfig, redis.bus);
  const app = makeApp({ redis, realtime });
  const server = await listen(app);
  return {
    url: server.url,
    app,
    redis,
    async stop() {
      await realtime.close();
      await redis.close();
      await server.stop();
    },
  };
}

let a: Instance;
let b: Instance;
let owner: TestUser;
let wsId: string;
let projectId: string;
let flagId: string;
let devId: string;
let devKey: string;
const clients: FlagForgeClient[] = [];

beforeAll(async () => {
  [a, b] = await Promise.all([startInstance(), startInstance()]);
});
afterAll(async () => {
  await Promise.all([a.stop(), b.stop()]);
});
afterEach(() => clients.splice(0).forEach((c) => c.close()));

const api = (inst: Instance, method: "post" | "put" | "delete" | "get", path: string, body?: object) => {
  const r = request(inst.app)[method](path).set("Authorization", owner.auth);
  return body ? r.send(body) : r;
};
const configure = (inst: Instance, body: object) =>
  api(inst, "put", `/workspaces/${wsId}/projects/${projectId}/flags/${flagId}/environments/${devId}`, body);
const sdk = (inst: Instance, overrides: Record<string, unknown> = {}) => {
  const client = new FlagForgeClient({
    apiKey: devKey,
    baseUrl: inst.url,
    pollIntervalMs: 0, // no polling: only the stream (and resync) can deliver changes
    requestTimeoutMs: 3000,
    maxBackoffMs: 100,
    ...overrides,
  });
  clients.push(client);
  return client;
};
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 5000, interval: 10 });
const on = (c: FlagForgeClient) => c.isEnabled("checkout", { key: "u1" });
const connected = (c: FlagForgeClient) => until(() => expect(c.status.stream).toBe("connected"));

beforeEach(async () => {
  await resetDb();
  owner = await registerUser(a.app, "owner@example.com");
  wsId = (await api(a, "post", "/workspaces", { name: "Acme", slug: "acme" })).body.id;
  const project = (await api(a, "post", `/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
  projectId = project.id;
  devId = project.environments.find((e: { key: string }) => e.key === "dev").id;
  flagId = (await api(a, "post", `/workspaces/${wsId}/projects/${projectId}/flags`, { key: "checkout", name: "C" })).body.id;
  devKey = (await api(a, "post", `/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys`, { name: "k" })).body.key;
});

describe("two instances sharing Postgres and Redis", () => {
  it("a change made through instance B reaches an SDK streaming from instance A", async () => {
    const client = sdk(a);
    await client.init();
    await connected(client);
    expect(on(client)).toBe(false);

    await configure(b, { enabled: true });
    await until(() => expect(on(client)).toBe(true)); // no polling: the event crossed Redis
    await configure(b, { enabled: false });
    await until(() => expect(on(client)).toBe(false));
  });

  it("SDKs on both instances hear a change made on either", async () => {
    const onA = sdk(a);
    const onB = sdk(b);
    await Promise.all([onA.init(), onB.init()]);
    await Promise.all([connected(onA), connected(onB)]);
    await configure(a, { enabled: true, rolloutPercentage: 100 });
    await until(() => expect([on(onA), on(onB)]).toEqual([true, true]));
    await configure(b, { enabled: false });
    await until(() => expect([on(onA), on(onB)]).toEqual([false, false]));
  });

  it("revoking a key through instance B closes the stream held open on instance A", async () => {
    const client = sdk(a);
    const errors: FlagForgeError[] = [];
    client.on("error", (e) => errors.push(e));
    await client.init();
    await connected(client);
    const keys = (await api(b, "get", `/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys`)).body.apiKeys;
    await api(b, "delete", `/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys/${keys[0].id}`);
    await until(() => expect(client.status.fatal).toBe(true));
    expect(errors.at(-1)!.status).toBe(401);
  });

  it("an instance that missed events while disconnected from Redis catches its SDKs up by resyncing", async () => {
    const client = sdk(a);
    await client.init();
    await connected(client);
    const resynced = vi.fn();
    a.redis.bus.onResync(resynced);

    await testRedis.client!.call("CLIENT", "KILL", "TYPE", "pubsub"); // A's subscriber connection drops...
    await configure(b, { enabled: true }); // ...and this change is published while A is not listening.

    await until(() => expect(resynced).toHaveBeenCalled()); // A reconnected and noticed it may have missed something
    await until(() => expect(on(client)).toBe(true)); // its SDK was brought up to date via a fresh hello, not by polling
    const dbVersion = (await prisma.environment.findUniqueOrThrow({ where: { id: devId } })).configVersion;
    expect(client.status.version).toBe(dbVersion);
  });

  it("an instance whose Redis is unreachable still serves its own changes, and its SDKs recover via polling", async () => {
    const c = await startInstance("redis://127.0.0.1:1", { waitForRedis: false }); // this instance cannot reach Redis
    try {
      const client = sdk(c, { pollIntervalMs: 100 });
      await client.init();
      await connected(client);

      await configure(c, { enabled: true }); // changed on the isolated instance: delivered locally, instantly
      await until(() => expect(on(client)).toBe(true));

      await configure(b, { enabled: false }); // changed elsewhere: this instance cannot hear it...
      await until(() => expect(on(client)).toBe(false)); // ...so polling is what catches the SDK up
    } finally {
      await c.stop();
    }
  });
});
