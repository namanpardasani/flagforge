import type { EvaluationDetail } from "@flagforge/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { FakeFlags, start, watch, type Viewer } from "./helpers.js";

const on: EvaluationDetail = { value: true, reason: "FALLTHROUGH" };
const off: EvaluationDetail = { value: false, reason: "OFF" };

let flags: FakeFlags;
let demo: Awaited<ReturnType<typeof start>>;
const viewers: Viewer[] = [];
const open = async (user: string) => {
  const viewer = await watch(demo.url, user);
  viewers.push(viewer);
  return viewer;
};

beforeEach(async () => {
  flags = new FakeFlags();
  flags.decide = () => ({ "one-tap-checkout": off, "bulk-label-print": on });
  demo = await start({ flags });
});
afterEach(async () => {
  viewers.splice(0).forEach((v) => v.close());
  await demo.stop();
});

describe("the page", () => {
  it("serves the page with no inline script or style, under a strict content policy", async () => {
    const res = await fetch(demo.url);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html).toContain('<script src="/app.js" defer></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // every script tag has a src
    expect(html).not.toMatch(/<style|style="|\son[a-z]+="/);
  });

  it("serves its script and styles from their own addresses", async () => {
    const js = await fetch(`${demo.url}/app.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("EventSource");
    expect((await fetch(`${demo.url}/app.css`)).headers.get("content-type")).toContain("text/css");
  });

  it("the browser script never builds markup from data", async () => {
    const js = await (await fetch(`${demo.url}/app.js`)).text();
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  it("lists the sample users and the featured flag", async () => {
    const config = (await (await fetch(`${demo.url}/api/config`)).json()) as { featuredFlag: string; users: { id: string; attributes: object }[] };
    expect(config.featuredFlag).toBe("one-tap-checkout");
    expect(config.users.map((u) => u.id)).toEqual(["ingrid", "tomasz", "saoirse", "kenji"]);
    expect(config.users[0]!.attributes).toMatchObject({ plan: "pro" });
  });

  it("answers only GET, and 404 for anything it does not serve", async () => {
    expect((await fetch(demo.url, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${demo.url}/events?user=ingrid`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${demo.url}/admin`)).status).toBe(404);
    expect((await fetch(`${demo.url}/../../etc/passwd`)).status).toBe(404);
  });

  it("reports health from the SDK's readiness", async () => {
    expect((await fetch(`${demo.url}/health`)).status).toBe(200);
    flags.status = { ...flags.status, ready: false };
    const res = await fetch(`${demo.url}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "waiting for flags" });
  });
});

describe("the event stream", () => {
  it("starts with a snapshot of every flag for that user, sorted, with the SDK's status", async () => {
    const viewer = await open("ingrid");
    expect(viewer.status).toBe(200);
    await viewer.next(1);
    const first = viewer.snapshots[0];
    expect(first.user).toMatchObject({ id: "ingrid", name: "Ingrid" });
    expect(first.flags).toEqual([
      { key: "bulk-label-print", value: true, reason: "FALLTHROUGH" },
      { key: "one-tap-checkout", value: false, reason: "OFF" },
    ]);
    expect(first.featured).toEqual({ key: "one-tap-checkout", exists: true, value: false });
    expect(first.sdk).toEqual({ ready: true, source: "network", stream: "connected", degraded: false, version: 1, fatal: false });
  });

  it("pushes a new snapshot the moment the SDK says the flags changed", async () => {
    const viewer = await open("ingrid");
    await viewer.next(1);
    flags.decide = () => ({ "one-tap-checkout": { value: true, reason: "RULE_MATCH", ruleId: "r1" } });
    flags.emitUpdate();
    await viewer.next(2);
    expect(viewer.snapshots[1].featured.value).toBe(true);
    expect(viewer.snapshots[1].flags).toEqual([{ key: "one-tap-checkout", value: true, reason: "RULE_MATCH", ruleId: "r1" }]);
  });

  it("evaluates for each viewer's own user: the same flag can differ between two people", async () => {
    flags.decide = (user) => ({ "one-tap-checkout": user.attributes?.["plan"] === "pro" ? { value: true, reason: "RULE_MATCH", ruleId: "pro" } : off });
    const [ingrid, tomasz] = await Promise.all([open("ingrid"), open("tomasz")]); // pro, free
    await Promise.all([ingrid.next(1), tomasz.next(1)]);
    expect(ingrid.snapshots[0].featured.value).toBe(true);
    expect(tomasz.snapshots[0].featured.value).toBe(false);
    expect(demo.app.viewers).toBe(2);
  });

  it("says when the featured flag does not exist yet, instead of pretending it is off", async () => {
    flags.decide = () => ({ "bulk-label-print": on });
    const viewer = await open("kenji");
    await viewer.next(1);
    expect(viewer.snapshots[0].featured).toEqual({ key: "one-tap-checkout", exists: false, value: false });
  });

  it("tells viewers when the SDK's connection status changes (there is no SDK event for that)", async () => {
    const viewer = await open("ingrid");
    await viewer.next(1);
    flags.status = { ...flags.status, stream: "disconnected" };
    await viewer.next(2);
    expect(viewer.snapshots[1].sdk.stream).toBe("disconnected");
  });

  it("sends only decisions: no rules, no percentages, nothing that looks like a key", async () => {
    const viewer = await open("ingrid");
    await viewer.next(1);
    const allowed = new Set(["key", "value", "reason", "ruleId"]);
    for (const flag of viewer.snapshots[0].flags) for (const field of Object.keys(flag)) expect(allowed.has(field)).toBe(true);
    expect(viewer.raw()).not.toMatch(/ff_|rolloutBps|conditions|apiKey/);
  });

  it("rejects a user it does not know, and a request without one", async () => {
    for (const query of ["?user=mallory", "", "?user=", "?user=ingrid%0Aevent%3A%20x", "?user=__proto__"]) {
      const res = await fetch(`${demo.url}/events${query}`);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
    expect(demo.app.viewers).toBe(0);
  });

  it("sends heartbeats, and forgets a viewer who leaves", async () => {
    const viewer = await open("ingrid");
    await viewer.next(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(viewer.raw()).toContain(": ping");
    viewer.close();
    await expect.poll(() => demo.app.viewers).toBe(0);
  });

  it("refuses more viewers than its limit, and frees a place when one leaves", async () => {
    await demo.stop();
    demo = await start({ flags, maxConnections: 2 });
    const [a] = await Promise.all([open("ingrid"), open("tomasz")]);
    expect((await fetch(`${demo.url}/events?user=kenji`)).status).toBe(503);
    a.close();
    await expect.poll(() => demo.app.viewers).toBe(1);
    expect((await open("kenji")).status).toBe(200);
  });

  it("closing the app ends every stream and stops listening to the SDK", async () => {
    const viewer = await open("ingrid");
    await viewer.next(1);
    expect(flags.listenerCount).toBe(1);
    demo.app.close();
    await viewer.closed;
    expect(demo.app.viewers).toBe(0);
    expect(flags.listenerCount).toBe(0);
  });
});

describe("configuration", () => {
  const good = { FLAGFORGE_API_KEY: "ff_" + "a".repeat(32) };

  it("fills in defaults", () => {
    expect(loadConfig(good)).toMatchObject({ FLAGFORGE_URL: "http://localhost:3000", PORT: 4000, HOST: "127.0.0.1", FEATURED_FLAG: "one-tap-checkout" });
  });

  it("names what is wrong without printing the value", () => {
    const secretLooking = "sk_live_not_a_flagforge_key_123456";
    let message = "";
    try {
      loadConfig({ FLAGFORGE_API_KEY: secretLooking, PORT: "99999" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("FLAGFORGE_API_KEY");
    expect(message).toContain("PORT");
    expect(message).not.toContain(secretLooking);
  });

  it("requires a key", () => {
    expect(() => loadConfig({})).toThrow(/FLAGFORGE_API_KEY/);
  });

  it("rejects a featured flag that could not be a flag key", () => {
    expect(() => loadConfig({ ...good, FEATURED_FLAG: "<script>" })).toThrow(/FEATURED_FLAG/);
  });
});
