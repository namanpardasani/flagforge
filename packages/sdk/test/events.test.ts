import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlagForgeClient, type FlagForgeError, type FlagForgeOptions } from "../src/index.js";
import { flag, snap, StubServer } from "./stub-server.js";

const API_KEY = "ff_test_key_1234567890";
let stub: StubServer;
const clients: FlagForgeClient[] = [];

beforeEach(async () => {
  stub = new StubServer({ ...snap([flag("checkout", { enabled: true, fallthroughBps: 10000 }), flag("banner", { enabled: false })], "prod"), version: 1 } as never);
  await stub.start();
});
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await stub.stop();
});

function make(overrides: Partial<FlagForgeOptions> = {}) {
  const client = new FlagForgeClient({
    apiKey: API_KEY,
    baseUrl: stub.url,
    streaming: false,
    pollIntervalMs: 0,
    requestTimeoutMs: 1000,
    sendEvents: true,
    eventsFlushIntervalMs: 30, // fast, so tests do not wait seconds
    ...overrides,
  });
  clients.push(client);
  return client;
}
const ready = async (overrides: Partial<FlagForgeOptions> = {}) => {
  const client = make(overrides);
  await client.init();
  return client;
};
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 3000, interval: 10 });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("off by default", () => {
  it("sends nothing and keeps no user keys when sendEvents is not set", async () => {
    const client = await ready({ sendEvents: undefined });
    client.isEnabled("checkout", { key: "alice" });
    client.track("checkout-completed", { key: "alice" });
    await client.flush();
    await wait(120);
    expect(stub.eventRequests).toHaveLength(0);
    expect(client.status.events).toEqual({ queued: 0, sent: 0, dropped: 0 });
  });
});

describe("exposures", () => {
  it("evaluate and isEnabled each report what the user was shown, with the value", async () => {
    const client = await ready();
    client.evaluate("checkout", { key: "alice" });
    client.isEnabled("banner", { key: "bob" });
    await client.flush();
    expect(stub.events).toEqual([
      { type: "exposure", flagKey: "checkout", userKey: "alice", value: true },
      { type: "exposure", flagKey: "banner", userKey: "bob", value: false },
    ]);
  });

  it("reports a user once per flag, however often they are checked", async () => {
    const client = await ready();
    for (let i = 0; i < 50; i++) client.isEnabled("checkout", { key: "alice" });
    client.isEnabled("checkout", { key: "bob" });
    client.isEnabled("banner", { key: "alice" });
    await client.flush();
    expect(stub.events).toHaveLength(3);
  });

  it("reports again if the value the user is shown changes", async () => {
    const client = await ready();
    client.isEnabled("checkout", { key: "alice" });
    stub.snapshot = { ...snap([flag("checkout", { enabled: false })], "prod"), version: 2 } as never;
    stub.etag = '"v2"';
    await client.refresh();
    client.isEnabled("checkout", { key: "alice" });
    await client.flush();
    expect(stub.events.map((e) => e["value"])).toEqual([true, false]);
  });

  it("does not report defaults: unknown flag, not ready, or a user without a key", async () => {
    const early = make();
    early.isEnabled("checkout", { key: "alice" }); // before init: not ready
    await early.init();
    const client = await ready();
    client.isEnabled("no-such-flag", { key: "alice" });
    client.isEnabled("checkout", { key: "" });
    await Promise.all([early.flush(), client.flush()]);
    expect(stub.events).toHaveLength(0);
  });

  it("allFlags does not report exposures (listing is not showing)", async () => {
    const client = await ready();
    const all = client.allFlags({ key: "alice" });
    expect(all["checkout"]).toMatchObject({ value: true });
    expect(all["banner"]).toMatchObject({ value: false, reason: "OFF" });
    await client.flush();
    expect(stub.events).toHaveLength(0);
  });
});

describe("conversions", () => {
  it("track sends a conversion", async () => {
    const client = await ready();
    client.track("checkout-completed", { key: "alice" });
    await client.flush();
    expect(stub.events).toEqual([{ type: "conversion", metricKey: "checkout-completed", userKey: "alice" }]);
  });

  it("ignores track calls it cannot make sense of, without throwing", async () => {
    const client = await ready();
    expect(() => {
      client.track("", { key: "alice" });
      client.track("m", { key: "" });
      client.track("m", undefined as never);
      client.track(undefined as never, { key: "alice" });
    }).not.toThrow();
    await client.flush();
    expect(stub.events).toHaveLength(0);
  });
});

describe("sending", () => {
  it("sends by itself after the interval, as one batch, with the API key", async () => {
    const client = await ready();
    client.isEnabled("checkout", { key: "a" });
    client.isEnabled("checkout", { key: "b" });
    client.track("m", { key: "a" });
    expect(stub.eventRequests).toHaveLength(0); // recording does not send
    await until(() => expect(stub.eventBatches).toHaveLength(1));
    expect(stub.eventBatches[0]!.events).toHaveLength(3);
    expect(stub.eventRequests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(stub.eventRequests[0]!.method).toBe("POST");
    await until(() => expect(client.status.events).toEqual({ queued: 0, sent: 3, dropped: 0 }));
  });

  it("a flag check never waits for the network: it returns at once even if the server is down", async () => {
    await stub.stop();
    const client = await ready({ bootstrap: { environment: { id: "e", key: "prod" }, flags: [flag("checkout")] } as never });
    client.on("error", () => {});
    const started = performance.now();
    for (let i = 0; i < 1000; i++) client.isEnabled("checkout", { key: `user-${i}` });
    expect(performance.now() - started).toBeLessThan(200);
    expect(client.status.events.queued).toBeGreaterThan(0);
  });

  it("splits a large backlog into requests of at most 500 events", async () => {
    const client = await ready({ eventsFlushIntervalMs: 60_000 });
    for (let i = 0; i < 1200; i++) client.isEnabled("checkout", { key: `user-${i}` });
    await client.flush();
    expect(stub.eventBatches.map((b) => b.events.length).sort((a, b) => b - a)).toEqual([500, 500, 200]);
    expect(client.status.events).toEqual({ queued: 0, sent: 1200, dropped: 0 });
  });

  it("a full batch is sent at once, without waiting for the timer", async () => {
    const client = await ready({ eventsFlushIntervalMs: 60_000 });
    for (let i = 0; i < 500; i++) client.isEnabled("checkout", { key: `user-${i}` });
    await until(() => expect(stub.events).toHaveLength(500));
  });

  it("close() makes a last attempt to send what is queued", async () => {
    const client = await ready({ eventsFlushIntervalMs: 60_000 });
    client.isEnabled("checkout", { key: "alice" });
    client.close();
    await until(() => expect(stub.events).toHaveLength(1));
  });

  it("records nothing after close()", async () => {
    const client = await ready({ eventsFlushIntervalMs: 60_000 });
    client.close();
    client.isEnabled("checkout", { key: "late" });
    client.track("m", { key: "late" });
    await wait(80);
    expect(stub.events).toHaveLength(0);
    expect(client.status.events.queued).toBe(0);
  });
});

describe("counting what is waiting", () => {
  it("events on their way to the server still count as queued until they are delivered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // A server that holds the request open, so the batch is in flight for as long as the test likes.
    const original = globalThis.fetch;
    const slow = ((input: unknown, init?: RequestInit) => (String(input).endsWith("/sdk/v1/events") ? gate.then(() => original(input as string, init)) : original(input as string, init))) as typeof fetch;
    const held = await ready({ fetch: slow, eventsFlushIntervalMs: 60_000 });
    held.isEnabled("checkout", { key: "a" });
    held.isEnabled("checkout", { key: "b" });
    const sending = held.flush();
    await wait(30);
    expect(held.status.events).toEqual({ queued: 2, sent: 0, dropped: 0 }); // in flight, not lost from the count
    release();
    await sending;
    expect(held.status.events).toEqual({ queued: 0, sent: 2, dropped: 0 });
  });
});

describe("when sending fails", () => {
  it("keeps the events and delivers them once the server recovers", async () => {
    const errors: FlagForgeError[] = [];
    const client = await ready();
    client.on("error", (e) => errors.push(e));
    stub.eventsStatus = 503;
    client.isEnabled("checkout", { key: "alice" });
    client.track("m", { key: "alice" });
    await until(() => expect(stub.eventRequests.length).toBeGreaterThanOrEqual(2)); // it keeps retrying
    expect(client.status.events).toMatchObject({ queued: 2, sent: 0, dropped: 0 });
    expect(stub.events).toHaveLength(0);

    stub.eventsStatus = 202;
    await until(() => expect(stub.events).toHaveLength(2));
    await until(() => expect(client.status.events).toMatchObject({ queued: 0, sent: 2 }));
  });

  it("a network failure is reported as an error event without the key or URL, and retried", async () => {
    const errors: FlagForgeError[] = [];
    const client = await ready({ fetch: (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/sdk/v1/events") && flaky) throw new TypeError(`connect ECONNREFUSED ${String(input)} ${API_KEY}`);
      return fetch(input as string, init);
    }) as typeof fetch });
    let flaky = true;
    client.on("error", (e) => errors.push(e));
    client.isEnabled("checkout", { key: "alice" });
    await until(() => expect(errors.length).toBeGreaterThan(0));
    for (const error of errors) {
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).not.toContain("http://");
    }
    flaky = false;
    await until(() => expect(stub.events).toHaveLength(1));
  });

  it("a rejected key stops reporting, drops the queue and says so once, as a fatal error", async () => {
    const errors: FlagForgeError[] = [];
    const client = await ready();
    client.on("error", (e) => errors.push(e));
    stub.eventsStatus = 401;
    client.isEnabled("checkout", { key: "alice" });
    client.isEnabled("checkout", { key: "bob" });
    await until(() => expect(errors.some((e) => e.fatal && e.status === 401)).toBe(true));
    expect(errors.find((e) => e.fatal)!.message).not.toContain(API_KEY);

    stub.eventsStatus = 202;
    client.isEnabled("checkout", { key: "carol" }); // after the rejection: not recorded
    await wait(120);
    expect(stub.events).toHaveLength(0);
    expect(client.status.events).toMatchObject({ queued: 0, sent: 0 });
    expect(client.status.events.dropped).toBeGreaterThanOrEqual(2);
    // Flag evaluation itself is unaffected.
    expect(client.isEnabled("checkout", { key: "dave" })).toBe(true);
  });

  it("a batch the server refuses as invalid is dropped, not retried forever", async () => {
    const client = await ready();
    client.on("error", () => {});
    stub.eventsStatus = 400;
    client.isEnabled("checkout", { key: "alice" });
    await until(() => expect(client.status.events.dropped).toBe(1));
    const requests = stub.eventRequests.length;
    await wait(150);
    expect(stub.eventRequests.length).toBe(requests); // no retry loop
    expect(client.status.events.queued).toBe(0);
  });

  it("memory is bounded: past the limit the OLDEST events are dropped and counted", async () => {
    stub.eventsStatus = 503;
    const client = await ready({ maxQueuedEvents: 100, eventsFlushIntervalMs: 60_000 });
    client.on("error", () => {});
    for (let i = 0; i < 250; i++) client.isEnabled("checkout", { key: `user-${i}` });
    expect(client.status.events.queued).toBe(100);
    expect(client.status.events.dropped).toBe(150);
    stub.eventsStatus = 202;
    await client.flush();
    // What survived are the newest 100.
    expect(stub.events.map((e) => e["userKey"])).toEqual(Array.from({ length: 100 }, (_, i) => `user-${150 + i}`));
  });
});
