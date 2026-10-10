import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusMessage } from "../src/realtime/bus.js";
import { createRedisClient } from "../src/redis/client.js";
import { RedisEventBus } from "../src/redis/event-bus.js";
import { testRedis } from "./helpers.js";
import { sleep } from "./sse-helper.js";

const URL = process.env["TEST_REDIS_URL"]!;
const until = (fn: () => void | Promise<void>, timeout = 4000) => vi.waitFor(fn, { timeout, interval: 10 });
const change = (environmentId: string, version: number): BusMessage => ({ type: "config", environmentId, version });

const open: Redis[] = [];
function makeBus(url = URL) {
  const pub = createRedisClient(url);
  const sub = new Redis(url, { retryStrategy: (n) => Math.min(n * 100, 500) });
  sub.on("error", () => {});
  open.push(pub, sub);
  return new RedisEventBus(pub, sub);
}
const numSub = async (channel: string) => {
  const result = (await testRedis.client!.call("PUBSUB", "NUMSUB", channel)) as [string, number];
  return Number(result[1]);
};

beforeEach(async () => {
  await testRedis.client!.flushdb();
});
afterEach(() => {
  open.splice(0).forEach((c) => c.disconnect());
});

describe("RedisEventBus across instances", () => {
  it("delivers an event to subscribers on OTHER instances", async () => {
    const a = makeBus();
    const b = makeBus();
    const heard: BusMessage[] = [];
    b.subscribe("env:e1", (m) => heard.push(m));
    await until(async () => expect(await numSub("ff:env:e1")).toBe(1));
    await a.publish("env:e1", change("e1", 7));
    await until(() => expect(heard).toEqual([change("e1", 7)]));
  });

  it("delivers to the publishing instance's own subscribers exactly once (no echo duplicate)", async () => {
    const a = makeBus();
    const b = makeBus();
    const onA: BusMessage[] = [];
    const onB: BusMessage[] = [];
    a.subscribe("env:e1", (m) => onA.push(m));
    b.subscribe("env:e1", (m) => onB.push(m));
    await until(async () => expect(await numSub("ff:env:e1")).toBe(2));
    await a.publish("env:e1", change("e1", 1));
    await until(() => expect(onB).toHaveLength(1));
    await sleep(150);
    expect(onA).toHaveLength(1); // delivered locally, and Redis's echo of our own message is ignored
    expect(onB).toHaveLength(1);
  });

  it("keeps topics separate", async () => {
    const a = makeBus();
    const b = makeBus();
    const e1: BusMessage[] = [];
    const e2: BusMessage[] = [];
    b.subscribe("env:e1", (m) => e1.push(m));
    b.subscribe("env:e2", (m) => e2.push(m));
    await until(async () => expect((await numSub("ff:env:e1")) + (await numSub("ff:env:e2"))).toBe(2));
    await a.publish("env:e2", change("e2", 3));
    await until(() => expect(e2).toHaveLength(1));
    await sleep(100);
    expect(e1).toHaveLength(0);
  });

  it("carries key-revocation messages too", async () => {
    const a = makeBus();
    const b = makeBus();
    const heard: BusMessage[] = [];
    b.subscribe("key:k1", (m) => heard.push(m));
    await until(async () => expect(await numSub("ff:key:k1")).toBe(1));
    await a.publish("key:k1", { type: "key_revoked", apiKeyId: "k1" });
    await until(() => expect(heard).toEqual([{ type: "key_revoked", apiKeyId: "k1" }]));
  });

  it("unsubscribes from Redis when the last local listener leaves, and not before", async () => {
    const bus = makeBus();
    const off1 = bus.subscribe("env:e1", () => {});
    const off2 = bus.subscribe("env:e1", () => {});
    await until(async () => expect(await numSub("ff:env:e1")).toBe(1)); // one Redis subscription, two local listeners
    off1();
    off1(); // double-unsubscribe is harmless
    await sleep(100);
    expect(await numSub("ff:env:e1")).toBe(1);
    off2();
    await until(async () => expect(await numSub("ff:env:e1")).toBe(0));
    expect(bus.topicCount).toBe(0);
  });

  it("ignores malformed or forged-looking messages instead of crashing", async () => {
    const b = makeBus();
    const heard: BusMessage[] = [];
    b.subscribe("env:e1", (m) => heard.push(m));
    await until(async () => expect(await numSub("ff:env:e1")).toBe(1));
    const raw = testRedis.client!;
    for (const payload of [
      "not json",
      "null",
      "42",
      '"a string"',
      "[]",
      "true",
      JSON.stringify({ from: "x" }),
      JSON.stringify({ from: "x", message: { type: "config", environmentId: 5, version: 1 } }),
      JSON.stringify({ from: "x", message: { type: "config", environmentId: "e1", version: 1.5 } }),
      JSON.stringify({ from: "x", message: { type: "unknown" } }),
    ]) {
      await raw.publish("ff:env:e1", payload);
    }
    await raw.publish("ff:env:e1", JSON.stringify({ from: "other", message: change("e1", 9) })); // a valid one still works
    await until(() => expect(heard).toEqual([change("e1", 9)]));
  });

  it("still delivers locally when Redis is unreachable, and publishing never throws", async () => {
    const bus = makeBus("redis://127.0.0.1:1");
    const heard: BusMessage[] = [];
    bus.subscribe("env:e1", (m) => heard.push(m));
    await expect(bus.publish("env:e1", change("e1", 1))).resolves.toBeUndefined();
    expect(heard).toEqual([change("e1", 1)]);
  });

  it("announces a resync after the subscriber connection drops and reconnects (events may have been missed)", async () => {
    const bus = makeBus();
    const resync = vi.fn();
    bus.onResync(resync);
    const heard: BusMessage[] = [];
    bus.subscribe("env:e1", (m) => heard.push(m));
    await until(async () => expect(await numSub("ff:env:e1")).toBe(1));
    expect(resync).not.toHaveBeenCalled(); // the first connection is not a "resync"

    await testRedis.client!.call("CLIENT", "KILL", "TYPE", "pubsub"); // sever every subscriber connection
    await until(() => expect(resync).toHaveBeenCalledTimes(1));
    // The subscription is restored automatically, so events flow again.
    await until(async () => expect(await numSub("ff:env:e1")).toBe(1));
    await testRedis.client!.publish("ff:env:e1", JSON.stringify({ from: "other", message: change("e1", 4) }));
    await until(() => expect(heard).toEqual([change("e1", 4)]));
  });

  it("onResync listeners can be removed, and a throwing one does not block the others", async () => {
    const bus = makeBus();
    bus.subscribe("env:e1", () => {}); // the connection must be subscribed to count as a pub/sub connection
    await until(async () => expect(await numSub("ff:env:e1")).toBe(1));
    const good = vi.fn();
    bus.onResync(() => {
      throw new Error("boom");
    });
    bus.onResync(good);
    const removed = vi.fn();
    bus.onResync(removed)();
    await testRedis.client!.call("CLIENT", "KILL", "TYPE", "pubsub");
    await until(() => expect(good).toHaveBeenCalled());
    expect(removed).not.toHaveBeenCalled();
  });

  it("two instances use different ids", () => {
    expect(makeBus().instanceId).not.toBe(makeBus().instanceId);
  });
});

describe("RedisEventBus health", () => {
  it("is unhealthy until the subscriber connection is ready, then healthy", async () => {
    const bus = makeBus();
    const changes: boolean[] = [];
    bus.onHealthChange((h) => changes.push(h));
    await until(() => expect(bus.isHealthy()).toBe(true));
    expect(changes).toEqual([true]);
  });

  it("goes unhealthy when the subscriber connection drops and healthy again when it returns", async () => {
    const bus = makeBus();
    bus.subscribe("env:e1", () => {});
    await until(() => expect(bus.isHealthy()).toBe(true));
    const changes: boolean[] = [];
    bus.onHealthChange((h) => changes.push(h));
    await testRedis.client!.call("CLIENT", "KILL", "TYPE", "pubsub");
    await until(() => expect(changes).toEqual([false, true]));
    expect(bus.isHealthy()).toBe(true);
  });

  it("stays unhealthy when Redis is unreachable", async () => {
    const bus = makeBus("redis://127.0.0.1:1");
    await sleep(300);
    expect(bus.isHealthy()).toBe(false);
  });

  it("supports removing listeners and survives a throwing one", async () => {
    const bus = makeBus();
    const good = vi.fn();
    bus.onHealthChange(() => {
      throw new Error("boom");
    });
    bus.onHealthChange(good);
    const removed = vi.fn();
    bus.onHealthChange(removed)();
    await until(() => expect(good).toHaveBeenCalledWith(true));
    expect(removed).not.toHaveBeenCalled();
  });
});

describe("RedisServices.close", () => {
  it("returns promptly even when Redis is unreachable and subscriptions are still queued (shutdown must not hang)", async () => {
    const { createRedisServices } = await import("../src/redis/index.js");
    const services = createRedisServices({ REDIS_URL: "redis://127.0.0.1:1", RATE_LIMIT_ENABLED: true });
    // These subscribe calls queue up behind the connection that never completes.
    services.bus.subscribe("env:e1", () => {});
    services.bus.subscribe("env:e2", () => {});
    const started = Date.now();
    await services.close();
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("closes cleanly when Redis is healthy", async () => {
    const { createRedisServices } = await import("../src/redis/index.js");
    const services = createRedisServices({ REDIS_URL: URL, RATE_LIMIT_ENABLED: true });
    await services.waitUntilReady(3000);
    services.bus.subscribe("env:e1", () => {});
    const started = Date.now();
    await services.close();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
