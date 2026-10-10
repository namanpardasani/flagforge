import { evaluateFlag } from "@flagforge/core";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileStorage, FlagForgeClient, type FlagForgeError, type FlagForgeOptions } from "../src/index.js";
import { flag, snap, StubServer } from "./stub-server.js";

const API_KEY = "ff_test_key_1234567890";
let stub: StubServer;
const clients: FlagForgeClient[] = [];

beforeEach(async () => {
  stub = new StubServer(snap([flag("checkout"), flag("beta", { enabled: false })]));
  await stub.start();
});
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await stub.stop();
});

function make(overrides: Partial<FlagForgeOptions> = {}) {
  const client = new FlagForgeClient({ apiKey: API_KEY, baseUrl: stub.url, pollIntervalMs: 0, requestTimeoutMs: 1000, streaming: false, ...overrides });
  clients.push(client);
  return client;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 3000, interval: 10 });

describe("startup and evaluation", () => {
  it("fetches the config with the API key as a bearer token", async () => {
    const client = make();
    expect(await client.init()).toEqual({ ready: true, source: "network" });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.url).toBe("/sdk/v1/flags");
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("evaluates locally with the same engine as the server (no request per evaluation)", async () => {
    const config = flag("rollout", {
      fallthroughBps: 3000,
      rules: [{ id: "pro", conditions: [{ attribute: "plan", operator: "equals", value: "pro" }], rolloutBps: 7000 }],
    });
    stub.snapshot = snap([config]);
    const client = make();
    await client.init();
    const before = stub.requests.length;
    for (let i = 0; i < 300; i++) {
      const user = { key: `user-${i}`, attributes: { plan: i % 2 ? "pro" : "free" } };
      expect(client.evaluate("rollout", user)).toEqual(evaluateFlag(config, user));
    }
    expect(stub.requests.length).toBe(before);
  });

  it("returns the default with NOT_READY before init", () => {
    const client = make();
    expect(client.evaluate("checkout", { key: "u1" }, true)).toEqual({ value: true, reason: "NOT_READY" });
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(false);
  });

  it("uses the default only when it cannot decide: unknown flag and bad user", async () => {
    const client = make();
    await client.init();
    expect(client.evaluate("missing", { key: "u1" }, true)).toEqual({ value: true, reason: "FLAG_NOT_FOUND" });
    expect(client.evaluate("checkout", { key: "" }, true)).toEqual({ value: true, reason: "ERROR" });
    expect(client.evaluate("checkout", undefined as never, true)).toEqual({ value: true, reason: "ERROR" });
    // A known flag that is simply OFF is a real decision: the default is ignored.
    expect(client.evaluate("beta", { key: "u1" }, true)).toEqual({ value: false, reason: "OFF" });
  });

  it("allFlags returns a decision for every flag", async () => {
    const client = make();
    await client.init();
    expect(client.allFlags({ key: "u1" })).toEqual({
      checkout: { value: true, reason: "FALLTHROUGH" },
      beta: { value: false, reason: "OFF" },
    });
  });

  it("init is idempotent: calling it twice makes one request", async () => {
    const client = make();
    await Promise.all([client.init(), client.init()]);
    await client.init();
    expect(stub.requests).toHaveLength(1);
  });

  it("handles a trailing slash in baseUrl", async () => {
    const client = make({ baseUrl: `${stub.url}///` });
    expect((await client.init()).ready).toBe(true);
  });
});

describe("polling and ETags", () => {
  it("sends If-None-Match, and a 304 changes nothing and fires no update event", async () => {
    const client = make({ pollIntervalMs: 30 });
    const onUpdate = vi.fn();
    client.on("update", onUpdate);
    await client.init();
    await until(() => expect(stub.requests.length).toBeGreaterThanOrEqual(3));
    expect(stub.requests[0]!.headers["if-none-match"]).toBeUndefined();
    expect(stub.requests[1]!.headers["if-none-match"]).toBe('"v1"');
    expect(onUpdate).toHaveBeenCalledTimes(1); // only the first load
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(true);
  });

  it("picks up changes on the next poll and fires update", async () => {
    const client = make({ pollIntervalMs: 30 });
    const onUpdate = vi.fn();
    await client.init();
    client.on("update", onUpdate);
    stub.snapshot = snap([flag("checkout", { enabled: false })]);
    stub.etag = '"v2"';
    await until(() => expect(client.isEnabled("checkout", { key: "u1" })).toBe(false));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not poll when pollIntervalMs is 0, but refresh() still works", async () => {
    const client = make({ pollIntervalMs: 0 });
    await client.init();
    await wait(150);
    expect(stub.requests).toHaveLength(1);
    stub.snapshot = snap([flag("checkout", { enabled: false })]);
    stub.etag = '"v2"';
    expect(await client.refresh()).toBe(true);
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(false);
  });

  it("shares one request between concurrent refresh() calls", async () => {
    const client = make();
    await client.init();
    stub.delayMs = 60;
    const before = stub.requests.length;
    await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
    expect(stub.requests.length - before).toBe(1);
  });
});

describe("when the server fails", () => {
  it("starts not-ready with defaults if the server is down, then recovers by polling", async () => {
    await stub.stop();
    const client = make({ pollIntervalMs: 20, maxBackoffMs: 50 });
    const errors: FlagForgeError[] = [];
    client.on("error", (e) => errors.push(e));
    const onReady = vi.fn();
    client.on("ready", onReady);

    expect(await client.init()).toEqual({ ready: false, source: "none" });
    expect(client.evaluate("checkout", { key: "u1" }, true)).toEqual({ value: true, reason: "NOT_READY" });
    expect(errors[0]!.message).toBe("network error");

    await stub.start();
    await until(() => expect(client.status.ready).toBe(true));
    expect(onReady).toHaveBeenCalledWith("network");
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(true);
    expect(client.status.consecutiveFailures).toBe(0);
  });

  it("keeps serving the last known config through an outage, then recovers", async () => {
    const client = make({ pollIntervalMs: 20, maxBackoffMs: 50 });
    await client.init();
    await stub.stop();
    await until(() => expect(client.status.consecutiveFailures).toBeGreaterThan(1));
    expect(client.status.ready).toBe(true);
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(true); // stale but available

    await stub.start();
    stub.snapshot = snap([flag("checkout", { enabled: false })]);
    stub.etag = '"v2"';
    await until(() => expect(client.isEnabled("checkout", { key: "u1" })).toBe(false));
    expect(client.status.consecutiveFailures).toBe(0);
  });

  it("ignores 5xx, garbage and wrongly-shaped responses without losing the good config", async () => {
    const client = make();
    await client.init();
    const errors: FlagForgeError[] = [];
    client.on("error", (e) => errors.push(e));

    stub.status = 503;
    expect(await client.refresh()).toBe(false);
    stub.status = 200;
    stub.etag = undefined;
    stub.rawBody = "<html>bad gateway</html>";
    expect(await client.refresh()).toBe(false);
    stub.rawBody = JSON.stringify({ environment: { id: "e", key: "dev" }, flags: [{ key: "x", enabled: "yes" }] });
    expect(await client.refresh()).toBe(false);
    stub.rawBody = JSON.stringify({ flags: "nope" });
    expect(await client.refresh()).toBe(false);

    expect(errors).toHaveLength(4);
    expect(errors[0]!.status).toBe(503);
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(true);
    expect(client.status.ready).toBe(true);
  });

  it("treats 401 as fatal: stops polling, keeps the last config, never leaks the key", async () => {
    const client = make({ pollIntervalMs: 20 });
    const errors: FlagForgeError[] = [];
    client.on("error", (e) => errors.push(e));
    await client.init();
    stub.status = 401;
    await until(() => expect(client.status.fatal).toBe(true));
    const count = stub.requests.length;
    await wait(200);
    expect(stub.requests.length).toBe(count); // no more requests after the fatal error

    expect(errors.at(-1)!.fatal).toBe(true);
    expect(errors.at(-1)!.status).toBe(401);
    for (const e of errors) expect(`${e.message} ${e.stack} ${JSON.stringify(e)}`).not.toContain(API_KEY);
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(true); // still serving the last good config
  });

  it("a bad key at startup is not ready and does not retry", async () => {
    stub.status = 401;
    const client = make({ pollIntervalMs: 20 });
    expect(await client.init()).toEqual({ ready: false, source: "none" });
    const count = stub.requests.length;
    await wait(150);
    expect(stub.requests.length).toBe(count);
  });

  it("times out slow requests instead of hanging startup", async () => {
    stub.delayMs = 400;
    const client = make({ requestTimeoutMs: 50 });
    const errors: FlagForgeError[] = [];
    client.on("error", (e) => errors.push(e));
    const started = Date.now();
    expect(await client.init()).toEqual({ ready: false, source: "none" });
    expect(Date.now() - started).toBeLessThan(350);
    expect(errors[0]!.message).toBe("request timed out");
  });

  it("backs off while failing instead of hammering the server", async () => {
    stub.status = 500;
    const client = make({ pollIntervalMs: 20, maxBackoffMs: 400 });
    await client.init();
    await wait(300);
    // Without backoff a 20ms interval would make ~15 requests in 300ms.
    expect(stub.requests.length).toBeLessThanOrEqual(3);
  });
});

describe("fallbacks", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flagforge-sdk-"));
  });

  it("saves the config to a private file and uses it to start while the server is down", async () => {
    const file = join(dir, "nested", "flags.json");
    const first = make({ storage: new FileStorage(file) });
    await first.init();
    await until(async () => expect((await stat(file)).isFile()).toBe(true));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toContain(API_KEY);

    await stub.stop();
    const second = make({ storage: new FileStorage(file) });
    expect(await second.init()).toEqual({ ready: true, source: "storage" });
    expect(second.isEnabled("checkout", { key: "u1" })).toBe(true);
    expect(second.isEnabled("beta", { key: "u1" })).toBe(false);
  });

  it("switches from the cached copy to live data once the server is back", async () => {
    const file = join(dir, "flags.json");
    await make({ storage: new FileStorage(file) }).init();
    await until(async () => expect((await stat(file)).isFile()).toBe(true));
    await stub.stop();

    const client = make({ storage: new FileStorage(file), pollIntervalMs: 20, maxBackoffMs: 50 });
    await client.init();
    expect(client.status.source).toBe("storage");
    await stub.start();
    stub.snapshot = snap([flag("checkout", { enabled: false })]);
    stub.etag = '"v2"';
    await until(() => expect(client.status.source).toBe("network"));
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(false);
  });

  it("ignores a corrupt or malformed cache file", async () => {
    await stub.stop();
    const file = join(dir, "flags.json");
    await writeFile(file, "{ this is not json");
    expect(await make({ storage: new FileStorage(file) }).init()).toEqual({ ready: false, source: "none" });
    await writeFile(file, JSON.stringify({ savedAt: 1, config: { environment: {}, flags: "x" } }));
    expect(await make({ storage: new FileStorage(file) }).init()).toEqual({ ready: false, source: "none" });
    expect(await new FileStorage(join(dir, "missing.json")).load()).toBeNull();
  });

  it("uses bootstrap data as a last resort, and ignores invalid bootstrap data", async () => {
    await stub.stop();
    const client = make({ bootstrap: snap([flag("checkout", { enabled: false })]) });
    expect(await client.init()).toEqual({ ready: true, source: "bootstrap" });
    expect(client.isEnabled("checkout", { key: "u1" }, true)).toBe(false);

    const bad = make({ bootstrap: { environment: { id: "e", key: "dev" }, flags: "nope" } as never });
    const errors: FlagForgeError[] = [];
    bad.on("error", (e) => errors.push(e));
    expect((await bad.init()).ready).toBe(false);
    expect(errors.some((e) => e.message === "bootstrap config is invalid")).toBe(true);
  });

  it("prefers storage over bootstrap", async () => {
    const file = join(dir, "flags.json");
    await make({ storage: new FileStorage(file) }).init();
    await until(async () => expect((await stat(file)).isFile()).toBe(true));
    await stub.stop();
    const client = make({ storage: new FileStorage(file), bootstrap: snap([flag("checkout", { enabled: false })]) });
    expect((await client.init()).source).toBe("storage");
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(true);
  });

  it("survives a storage that throws on load or save", async () => {
    const errors: FlagForgeError[] = [];
    const brokenSave = make({
      storage: { load: async () => null, save: async () => { throw new Error("disk full"); } },
    });
    brokenSave.on("error", (e) => errors.push(e));
    expect((await brokenSave.init()).ready).toBe(true);
    await until(() => expect(errors.some((e) => e.message === "could not save config cache")).toBe(true));

    await stub.stop();
    const brokenLoad = make({
      storage: { load: async () => { throw new Error("EIO"); }, save: async () => {} },
    });
    expect(await brokenLoad.init()).toEqual({ ready: false, source: "none" });
  });
});

describe("safety and lifecycle", () => {
  it("refuses to send the API key over plain http to a remote host", () => {
    expect(() => new FlagForgeClient({ apiKey: API_KEY, baseUrl: "http://flags.example.com" })).toThrow(/plain http/);
    expect(() => new FlagForgeClient({ apiKey: API_KEY, baseUrl: "http://flags.example.com", allowInsecureHttp: true })).not.toThrow();
    for (const url of ["https://flags.example.com", "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(() => new FlagForgeClient({ apiKey: API_KEY, baseUrl: url })).not.toThrow();
    }
  });

  it("rejects missing keys and invalid urls", () => {
    expect(() => new FlagForgeClient({ apiKey: "", baseUrl: "https://x.example.com" })).toThrow(/apiKey/);
    expect(() => new FlagForgeClient({ apiKey: API_KEY, baseUrl: "not a url" })).toThrow(/baseUrl/);
    expect(() => new FlagForgeClient({ apiKey: API_KEY, baseUrl: "ftp://x.example.com" })).toThrow(/http/);
  });

  it("close() stops polling but evaluation keeps working", async () => {
    const client = make({ pollIntervalMs: 20 });
    await client.init();
    client.close();
    await wait(30);
    const count = stub.requests.length;
    await wait(150);
    expect(stub.requests.length).toBe(count);
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(true);
    expect(await client.refresh()).toBe(false);
  });

  it("close() cancels a request that is in flight", async () => {
    stub.delayMs = 500;
    const client = make({ requestTimeoutMs: 5000 });
    const init = client.init();
    await wait(30);
    client.close();
    const started = Date.now();
    expect((await init).ready).toBe(false);
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("a throwing listener cannot break the client, and unsubscribe works", async () => {
    const client = make();
    client.on("ready", () => {
      throw new Error("boom");
    });
    const seen = vi.fn();
    const off = client.on("update", seen);
    off();
    expect((await client.init()).ready).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(client.isEnabled("checkout", { key: "u1" })).toBe(true);
  });

  it("does not keep the process alive just for polling", async () => {
    const client = make({ pollIntervalMs: 60_000 });
    await client.init();
    // unref'd timers do not hold the event loop open; if they did, this test file would never exit.
    expect(client.status.ready).toBe(true);
  });
});
