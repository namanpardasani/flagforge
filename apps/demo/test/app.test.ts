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

  it("answers GET for pages, POST only for /pay and /simulate, and 404 for anything it does not serve", async () => {
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
    expect(first.sdk).toEqual({ ready: true, source: "network", stream: "connected", degraded: false, version: 1, fatal: false, events: { queued: 0, sent: 0, dropped: 0 } });
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

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${demo.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("experiment exposures", () => {
  it("watching the shop counts as being shown the featured flag, once", async () => {
    const viewer = await open("ingrid");
    await viewer.next(1);
    flags.emitUpdate();
    flags.emitUpdate();
    await viewer.next(3);
    expect(flags.recorded.filter((e) => e.type === "exposure" && e.flagKey === "one-tap-checkout")).toHaveLength(3); // the SDK itself de-duplicates; the app asks each time
    expect(flags.recorded.every((e) => e.type === "exposure" && e.userKey === "user-ingrid")).toBe(true);
  });

  it("only the featured flag is an exposure: listing the other flags is not showing them", async () => {
    const viewer = await open("tomasz");
    await viewer.next(1);
    expect(flags.recorded.map((e) => (e.type === "exposure" ? e.flagKey : ""))).toEqual(["one-tap-checkout"]);
  });

  it("a featured flag that does not exist records nothing", async () => {
    flags.decide = () => ({ "bulk-label-print": on });
    const viewer = await open("kenji");
    await viewer.next(1);
    expect(flags.recorded).toEqual([]);
  });
});

describe("paying", () => {
  it("records a conversion for the customer who paid, after making sure they were shown a checkout", async () => {
    flags.decide = () => ({ "one-tap-checkout": on });
    const res = await post("/pay", { user: "saoirse" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "saoirse", paid: true, oneTap: true, event: "checkout-completed" });
    expect(flags.recorded).toEqual([
      { type: "exposure", flagKey: "one-tap-checkout", userKey: "user-saoirse", value: true },
      { type: "conversion", metricKey: "checkout-completed", userKey: "user-saoirse" },
    ]);
  });

  it("rejects unknown customers, extra fields, and anything that is not JSON", async () => {
    expect((await post("/pay", { user: "mallory" })).status).toBe(400);
    expect((await post("/pay", { user: "ingrid", metric: "x" })).status).toBe(400);
    expect((await post("/pay", {})).status).toBe(400);
    expect((await post("/pay", "not json")).status).toBe(400);
    expect((await post("/pay", { user: "ingrid" }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await fetch(`${demo.url}/pay`, { method: "POST", body: "user=ingrid" })).status).toBe(415); // what a cross-site form sends
    expect(flags.recorded).toEqual([]);
  });

  it("refuses a request that comes from another website", async () => {
    expect((await post("/pay", { user: "ingrid" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/simulate", { shoppers: 5 }, { Origin: "http://localhost:9999" })).status).toBe(403);
    expect(flags.recorded).toEqual([]);
    // The same site is fine.
    expect((await post("/pay", { user: "ingrid" }, { Origin: demo.url })).status).toBe(200);
  });

  it("refuses an oversized body", async () => {
    const res = await post("/pay", { user: "ingrid", pad: "x".repeat(5000) }).catch(() => null);
    expect(res === null || res.status === 413).toBe(true);
    expect(flags.recorded).toEqual([]);
  });

  it("GET on /pay or /simulate is not allowed", async () => {
    expect((await fetch(`${demo.url}/pay`)).status).toBe(404);
    expect((await fetch(`${demo.url}/simulate`)).status).toBe(404);
    expect((await fetch(`${demo.url}/pay`, { method: "PUT" })).status).toBe(405);
  });
});

describe("simulated shoppers", () => {
  const sims = () => flags.recorded.filter((e) => e.type === "exposure");
  const converted = () => flags.recorded.filter((e) => e.type === "conversion");

  it("each shopper is shown the checkout (exposure) and pays with a probability that depends on which one", async () => {
    await demo.stop();
    // 0.12 is below the one-tap rate (14%) and above the card-form rate (10%): only one-tap shoppers pay.
    demo = await start({ flags, random: () => 0.12 });
    flags.decide = () => ({ "one-tap-checkout": on });
    const res = await post("/simulate", { shoppers: 50 });
    expect(await res.json()).toEqual({ shoppers: 50, withFlag: 50, withoutFlag: 0, conversions: 50 });
    flags.recorded.length = 0;

    flags.decide = () => ({ "one-tap-checkout": off });
    expect(await (await post("/simulate", { shoppers: 50 })).json()).toEqual({ shoppers: 50, withFlag: 0, withoutFlag: 50, conversions: 0 });
    expect(sims()).toHaveLength(50);
    expect(converted()).toHaveLength(0);
  });

  it("uses the stated rates at the boundaries", async () => {
    await demo.stop();
    demo = await start({ flags, random: () => 0.05 }); // below both rates: everyone pays
    flags.decide = (user) => ({ "one-tap-checkout": Number(user.key.split("-").pop()) % 2 === 0 ? on : off });
    const res = await (await post("/simulate", { shoppers: 20 })).json();
    expect(res).toMatchObject({ shoppers: 20, withFlag: 10, withoutFlag: 10, conversions: 20 });
    await demo.stop();
    demo = await start({ flags, random: () => 0.5 }); // above both: no one pays
    expect(((await (await post("/simulate", { shoppers: 20 })).json()) as { conversions: number }).conversions).toBe(0);
  });

  it("every shopper is a different person, and each run uses new people", async () => {
    flags.decide = () => ({ "one-tap-checkout": on });
    await post("/simulate", { shoppers: 30 });
    await post("/simulate", { shoppers: 30 });
    expect(new Set(sims().map((e) => e.userKey)).size).toBe(60);
  });

  it("only converts shoppers it also exposed", async () => {
    flags.decide = () => ({ "one-tap-checkout": on });
    await post("/simulate", { shoppers: 200 });
    const exposed = new Set(sims().map((e) => e.userKey));
    expect(converted().every((e) => exposed.has(e.userKey))).toBe(true);
  });

  it("accepts 1 to 1000 shoppers and nothing else", async () => {
    flags.decide = () => ({ "one-tap-checkout": on });
    expect((await post("/simulate", { shoppers: 1000 })).status).toBe(200);
    for (const shoppers of [0, -5, 1001, 2.5, "200", null, 1e9]) expect((await post("/simulate", { shoppers })).status).toBe(400);
    expect((await post("/simulate", {})).status).toBe(400);
    expect((await post("/simulate", { shoppers: 5, extra: true })).status).toBe(400);
  });

  it("announces its made-up rates so the page can say they are made up", async () => {
    const config = (await (await fetch(`${demo.url}/api/config`)).json()) as { simulation: Record<string, number>; conversionEvent: string };
    expect(config.simulation).toMatchObject({ conversionWithout: 0.1, conversionWith: 0.14, maxShoppers: 1000 });
    expect(config.conversionEvent).toBe("checkout-completed");
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
