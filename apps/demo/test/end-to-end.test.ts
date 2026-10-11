import { FlagForgeClient } from "@flagforge/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The SDK's own stand-in for the FlagForge server (serves /sdk/v1/flags and the SSE stream).
import { flag, snap, StubServer } from "../../../packages/sdk/test/stub-server.js";
import { start, watch, type Viewer } from "./helpers.js";

/**
 * The whole chain with the REAL SDK: FlagForge (stubbed) -> SDK -> demo server -> browser stream.
 * This is what the demo exists to show, so it is tested as one piece.
 */
const API_KEY = "ff_demo_test_key_0123456789abcdef";
let stub: StubServer;
let client: FlagForgeClient;
let demo: Awaited<ReturnType<typeof start>>;
let viewer: Viewer;

const serve = (version: number, ...flags: ReturnType<typeof flag>[]) => {
  stub.snapshot = { ...snap(flags, "prod"), version };
  stub.etag = `"v${version}"`;
};
const proOnly = flag("one-tap-checkout", {
  fallthroughBps: 0,
  rules: [{ id: "pro-customers", conditions: [{ attribute: "plan", operator: "equals", value: "pro" }], rolloutBps: 10000 }],
});

beforeEach(async () => {
  stub = new StubServer(snap([]));
  serve(1, flag("one-tap-checkout", { enabled: false }));
  await stub.start();
  client = new FlagForgeClient({ apiKey: API_KEY, baseUrl: stub.url, pollIntervalMs: 0, maxBackoffMs: 50 });
  await client.init();
  demo = await start({ flags: client });
});
afterEach(async () => {
  viewer?.close();
  await demo.stop();
  client.close();
  await stub.stop();
});

describe("a flag flipped in FlagForge reaches the browser", () => {
  it("shows the card form while the flag is off, then one-tap once it is turned on", async () => {
    viewer = await watch(demo.url, "ingrid");
    await viewer.next(1);
    expect(viewer.snapshots[0].featured).toEqual({ key: "one-tap-checkout", exists: true, value: false });
    expect(viewer.snapshots[0].flags[0].reason).toBe("OFF");

    // Someone turns the flag on in the dashboard: FlagForge bumps the version and rings the stream.
    serve(2, flag("one-tap-checkout", { enabled: true }));
    stub.sendChange(2);

    await expect.poll(() => viewer.snapshots.at(-1).featured.value, { timeout: 3000 }).toBe(true);
    const latest = viewer.snapshots.at(-1);
    expect(latest.flags[0]).toEqual({ key: "one-tap-checkout", value: true, reason: "FALLTHROUGH" });
    expect(latest.sdk.version).toBe(2);
  });

  it("a targeting rule gives two customers different checkouts, and says why", async () => {
    serve(2, proOnly);
    stub.sendChange(2);
    await expect.poll(() => client.status.version).toBe(2);

    viewer = await watch(demo.url, "ingrid"); // plan: pro
    const other = await watch(demo.url, "tomasz"); // plan: free
    await Promise.all([viewer.next(1), other.next(1)]);
    expect(viewer.snapshots[0].flags[0]).toEqual({ key: "one-tap-checkout", value: true, reason: "RULE_MATCH", ruleId: "pro-customers" });
    expect(other.snapshots[0].flags[0]).toEqual({ key: "one-tap-checkout", value: false, reason: "FALLTHROUGH" });
    other.close();
  });

  it("keeps answering from the last known flags when FlagForge goes away", async () => {
    serve(2, flag("one-tap-checkout", { enabled: true }));
    stub.sendChange(2);
    await expect.poll(() => client.status.version).toBe(2);

    await stub.stop(); // FlagForge is down
    viewer = await watch(demo.url, "ingrid");
    await viewer.next(1);
    expect(viewer.snapshots[0].featured.value).toBe(true); // still the last answer
    await expect.poll(() => viewer.snapshots.at(-1).sdk.stream, { timeout: 3000 }).not.toBe("connected");
  });

  it("never lets the API key reach a browser, in any response", async () => {
    viewer = await watch(demo.url, "ingrid");
    await viewer.next(1);
    const everything = [viewer.raw()];
    for (const path of ["/", "/app.js", "/app.css", "/api/config", "/health", "/nope"]) {
      const res = await fetch(`${demo.url}${path}`);
      everything.push(await res.text(), JSON.stringify([...res.headers]));
    }
    expect(everything.join("\n")).not.toContain(API_KEY);
    expect(everything.join("\n")).not.toContain(API_KEY.slice(3, 20));
    // And it really was used, server-side, to talk to FlagForge.
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });
});
