import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlagForgeClient, type FlagForgeError, type FlagForgeOptions } from "../src/index.js";
import { flag, snap, StubServer } from "./stub-server.js";

const API_KEY = "ff_test_key_1234567890";
let stub: StubServer;
const clients: FlagForgeClient[] = [];

/** Sets what the stub serves at /sdk/v1/flags: an environment at `version` with the given flags. */
const serve = (version: number, ...flags: ReturnType<typeof flag>[]) => {
  stub.snapshot = { ...snap(flags), version };
  stub.etag = `"v${version}"`;
};
const checkout = (enabled: boolean) => flag("checkout", { enabled });

beforeEach(async () => {
  stub = new StubServer(snap([]));
  serve(1, checkout(true));
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
    pollIntervalMs: 0,
    requestTimeoutMs: 1000,
    maxBackoffMs: 50, // fast reconnects
    streaming: true,
    ...overrides,
  });
  clients.push(client);
  return client;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 3000, interval: 10 });
const on = (client: FlagForgeClient) => client.isEnabled("checkout", { key: "u1" });
const connected = (client: FlagForgeClient) => until(() => expect(client.status.stream).toBe("connected"));

describe("stream connection", () => {
  it("opens the stream with the API key; a hello at the same version causes no extra fetch", async () => {
    const client = make();
    await client.init();
    await connected(client);
    const req = stub.streamRequests[0]!;
    expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(req.headers.accept).toBe("text/event-stream");
    expect(req.headers["last-event-id"]).toBe("1");
    await wait(150);
    expect(stub.flagRequests).toHaveLength(1);
    expect(client.status.version).toBe(1);
  });

  it("never opens a stream when streaming is off", async () => {
    const client = make({ streaming: false });
    await client.init();
    await wait(100);
    expect(stub.streamRequests).toHaveLength(0);
    expect(client.status.stream).toBe("off");
  });

  it("reports connecting, connected and disconnected", async () => {
    const client = make();
    expect(client.status.stream).toBe("connecting");
    await client.init();
    await connected(client);
    client.close();
    expect(client.status.stream).toBe("disconnected");
  });

  it("close() ends the stream and stops reconnecting", async () => {
    const client = make();
    await client.init();
    await connected(client);
    client.close();
    await until(() => expect(stub.streams).toHaveLength(0));
    const count = stub.streamRequests.length;
    await wait(200);
    expect(stub.streamRequests.length).toBe(count);
  });
});

describe("applying pushed changes", () => {
  it("applies a change within moments, with no polling at all", async () => {
    const client = make({ pollIntervalMs: 0 });
    const onUpdate = vi.fn();
    await client.init();
    await connected(client);
    client.on("update", onUpdate);
    expect(on(client)).toBe(true);

    serve(2, checkout(false));
    const started = Date.now();
    stub.sendChange(2);
    await until(() => expect(on(client)).toBe(false));
    expect(Date.now() - started).toBeLessThan(500);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(client.status.version).toBe(2);
    expect(stub.flagRequests).toHaveLength(2);
  });

  it("ignores events that are not newer than what it already has", async () => {
    const client = make();
    await client.init();
    await connected(client);
    stub.sendChange(1);
    stub.sendChange(0);
    await wait(150);
    expect(stub.flagRequests).toHaveLength(1);
  });

  it("ignores unknown events, garbled data and wrong types, then still works", async () => {
    const client = make();
    await client.init();
    await connected(client);
    stub.sendRaw("event: other\ndata: {}\n\n");
    stub.sendRaw("event: change\ndata: not json\n\n");
    stub.sendRaw('event: change\ndata: {"version":"9"}\n\n');
    stub.sendRaw('event: change\ndata: {"version":-1}\n\n');
    stub.sendRaw('event: change\ndata: {"version":1.5}\n\n');
    stub.sendRaw('event: change\ndata: {}\n\n');
    stub.sendRaw(": just a comment\n\n");
    await wait(150);
    expect(stub.flagRequests).toHaveLength(1);
    expect(client.status.stream).toBe("connected");

    serve(2, checkout(false));
    stub.sendChange(2);
    await until(() => expect(on(client)).toBe(false));
  });

  it("handles an event split across network chunks", async () => {
    const client = make();
    await client.init();
    await connected(client);
    serve(2, checkout(false));
    stub.sendRaw("event: change\nid: 2\nda");
    await wait(30);
    stub.sendRaw('ta: {"vers');
    await wait(30);
    stub.sendRaw('ion":2}\n\n');
    await until(() => expect(on(client)).toBe(false));
  });

  it("keeps fetching until it has the announced version, even if the server lags behind the event", async () => {
    const client = make();
    await client.init();
    await connected(client);
    // The event arrives first; the flags endpoint only catches up 200ms later.
    stub.sendChange(2);
    setTimeout(() => serve(2, checkout(false)), 200);
    await until(() => expect(client.status.version).toBe(2));
    expect(on(client)).toBe(false);
    expect(stub.flagRequests.length).toBeGreaterThanOrEqual(3);
  });

  it("copes with a burst of events: ends on the newest version without a request per event", async () => {
    const client = make();
    await client.init();
    await connected(client);
    serve(6, checkout(false));
    for (let v = 2; v <= 6; v++) stub.sendChange(v);
    await until(() => expect(client.status.version).toBe(6));
    expect(on(client)).toBe(false);
    expect(stub.flagRequests.length).toBeLessThanOrEqual(4);
  });

  it("does not loop forever against an older server that reports no versions", async () => {
    stub.snapshot = snap([checkout(true)]); // no version field
    stub.helloVersion = 2;
    const client = make();
    await client.init();
    await connected(client);
    await wait(150);
    const settled = stub.flagRequests.length;
    expect(settled).toBeLessThanOrEqual(3);
    await wait(300);
    expect(stub.flagRequests.length).toBe(settled);
  });
});

describe("reconnecting and resyncing", () => {
  it("reconnects after the server drops the stream, and the hello catches up on missed changes", async () => {
    const client = make();
    await client.init();
    await connected(client);

    stub.streamStatus = 503; // cannot reconnect yet
    stub.dropStreams();
    await until(() => expect(client.status.stream).toBe("disconnected"));
    serve(3, checkout(false)); // a change happens while the SDK is offline: no event for it
    stub.streamStatus = 200;

    await until(() => expect(client.status.stream).toBe("connected"));
    await until(() => expect(on(client)).toBe(false)); // learned from the hello (version 3), not from polling
    expect(client.status.version).toBe(3);
    expect(stub.streamRequests.length).toBeGreaterThanOrEqual(2);
  });

  it("resyncs when the hello version is OLDER (e.g. the database was restored)", async () => {
    serve(10, checkout(true));
    const client = make();
    await client.init();
    await connected(client);
    stub.streamStatus = 503;
    stub.dropStreams();
    await until(() => expect(client.status.stream).toBe("disconnected"));
    serve(4, checkout(false));
    stub.streamStatus = 200;
    await until(() => expect(client.status.version).toBe(4));
    expect(on(client)).toBe(false);
  });

  it("retries with backoff on 429/5xx without treating them as fatal, and recovers", async () => {
    stub.streamStatus = 429;
    const client = make({ maxBackoffMs: 400 });
    const errors: FlagForgeError[] = [];
    client.on("error", (e) => errors.push(e));
    await client.init();
    await wait(250);
    expect(stub.streamRequests.length).toBeLessThanOrEqual(2); // backing off, not hammering
    expect(client.status.fatal).toBe(false);
    expect(errors[0]!.status).toBe(429);

    stub.streamStatus = 200;
    await until(() => expect(client.status.stream).toBe("connected"));
  });

  it("treats 401 on the stream as fatal: stops streaming and polling, keeps serving the last config", async () => {
    stub.streamStatus = 401;
    const client = make({ pollIntervalMs: 20 });
    const errors: FlagForgeError[] = [];
    client.on("error", (e) => errors.push(e));
    await client.init();
    await until(() => expect(client.status.fatal).toBe(true));
    const streams = stub.streamRequests.length;
    const flags = stub.flagRequests.length;
    await wait(200);
    expect(stub.streamRequests.length).toBe(streams);
    expect(stub.flagRequests.length).toBe(flags);
    expect(errors.at(-1)!.fatal).toBe(true);
    for (const e of errors) expect(`${e.message} ${e.stack}`).not.toContain(API_KEY);
    expect(on(client)).toBe(true);
  });

  it("starts streaming even when the first fetch failed, and becomes ready once the server is back", async () => {
    await stub.stop();
    const client = make({ pollIntervalMs: 20 });
    expect((await client.init()).ready).toBe(false);
    await stub.start();
    await until(() => expect(client.status.ready).toBe(true));
    await connected(client);
  });
});

describe("watchdog", () => {
  it("reconnects when the stream goes silent (half-open connection)", async () => {
    const client = make({ streamIdleTimeoutMs: 100 });
    const errors: FlagForgeError[] = [];
    client.on("error", (e) => errors.push(e));
    await client.init();
    await until(() => expect(stub.streamRequests.length).toBeGreaterThanOrEqual(2));
    expect(errors.some((e) => e.message === "stream went silent")).toBe(true);
  });

  it("heartbeats keep a quiet stream open", async () => {
    stub.heartbeatMs = 30;
    const client = make({ streamIdleTimeoutMs: 150 });
    await client.init();
    await connected(client);
    await wait(500);
    expect(stub.streamRequests).toHaveLength(1);
    expect(client.status.stream).toBe("connected");
  });
});

describe("polling as a safety net", () => {
  it("polls normally while the stream is down, and only rarely while it is up", async () => {
    stub.streamStatus = 503;
    const client = make({ pollIntervalMs: 25, streamPollIntervalMs: 5000 });
    await client.init();

    // Stream down: polling picks up changes.
    serve(2, checkout(false));
    await until(() => expect(on(client)).toBe(false));

    // Stream up: polling slows right down.
    stub.streamStatus = 200;
    await connected(client);
    await wait(60); // let the already-scheduled fast poll fire
    const settled = stub.flagRequests.length;
    await wait(300);
    expect(stub.flagRequests.length).toBe(settled);

    // Stream drops again: fast polling resumes.
    stub.streamStatus = 503;
    stub.dropStreams();
    await until(() => expect(client.status.stream).toBe("disconnected"));
    serve(3, checkout(true));
    await until(() => expect(on(client)).toBe(true));
  });

  it("does not poll at all when pollIntervalMs is 0, but still follows the stream", async () => {
    const client = make({ pollIntervalMs: 0 });
    await client.init();
    await connected(client);
    await wait(150);
    expect(stub.flagRequests).toHaveLength(1);
    serve(2, checkout(false));
    stub.sendChange(2);
    await until(() => expect(on(client)).toBe(false));
  });
});

describe("degraded stream (the server lost its own event feed)", () => {
  const degrade = () => stub.sendRaw('event: degraded\ndata: {"degraded":true}\n\n');
  const recover = (version: number) => stub.sendRaw(`event: hello\nid: ${version}\ndata: {"version":${version}}\n\n`);

  it("goes back to normal-rate polling while degraded, and trusts the stream again after the next hello", async () => {
    const client = make({ pollIntervalMs: 25, streamPollIntervalMs: 5000 });
    await client.init();
    await connected(client);
    await wait(80);
    const slow = stub.flagRequests.length;
    await wait(250);
    expect(stub.flagRequests.length).toBe(slow); // healthy stream: polling is nearly off

    degrade();
    await until(() => expect(client.status.streamDegraded).toBe(true));
    serve(2, checkout(false)); // a change that no event announces
    await until(() => expect(on(client)).toBe(false)); // found by normal polling
    expect(client.status.stream).toBe("connected"); // still connected, just not trusted

    recover(2);
    await until(() => expect(client.status.streamDegraded).toBe(false));
    await wait(80);
    const settled = stub.flagRequests.length;
    await wait(250);
    expect(stub.flagRequests.length).toBe(settled); // slow safety-net polling again
  });

  it("a fresh connection starts trusted (the server will say again if it is still degraded)", async () => {
    const client = make({ pollIntervalMs: 25, streamPollIntervalMs: 5000 });
    await client.init();
    await connected(client);
    degrade();
    await until(() => expect(client.status.streamDegraded).toBe(true));
    stub.dropStreams();
    await until(() => expect(client.status.streamDegraded).toBe(false));
    await connected(client);
  });

  it("a hello that is not preceded by a degraded event changes nothing", async () => {
    const client = make();
    await client.init();
    await connected(client);
    recover(1);
    await wait(100);
    expect(client.status.streamDegraded).toBe(false);
    expect(stub.flagRequests).toHaveLength(1);
  });
});
