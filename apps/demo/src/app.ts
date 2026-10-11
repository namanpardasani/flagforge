import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ClientStatus, EvaluationDetail, EvaluationContext } from "@flagforge/sdk";
import { z } from "zod";
import { APP_CSS, APP_JS, PAGE_HTML } from "./page.js";
import { findUser, USERS, type DemoUser } from "./users.js";

/** The part of the SDK client this app uses. Declaring it lets tests pass in a stand-in. */
export interface FlagSource {
  allFlags(user: EvaluationContext): Record<string, EvaluationDetail>;
  /** Decides one flag AND records that this user was shown the result (an experiment exposure). */
  evaluate(flagKey: string, user: EvaluationContext, defaultValue?: boolean): EvaluationDetail;
  /** Records that this user did the thing an experiment measures. */
  track(metricKey: string, user: EvaluationContext): void;
  readonly status: ClientStatus;
  on(event: "update", listener: () => void): () => void;
}

/**
 * The made-up behaviour of the simulated shoppers: how many of them pay, with and without the
 * one-tap checkout. They exist so an experiment can collect enough data to say something; the
 * numbers are invented here, and an experiment on this flag should find them again.
 */
export const SIMULATION = { conversionWithout: 0.1, conversionWith: 0.14, maxShoppers: 1000 } as const;
/** The event a successful payment reports. Create an experiment that measures this name. */
export const CONVERSION_EVENT = "checkout-completed";

export interface DemoAppOptions {
  flags: FlagSource;
  /** The flag that switches the mock checkout. */
  featuredFlag: string;
  heartbeatMs?: number;
  /** How often to look for a change in the SDK's connection status (it has no event for that). */
  statusCheckMs?: number;
  maxConnections?: number;
  /** Source of randomness for the simulation. Tests pass a fixed one. */
  random?: () => number;
}

// The only input a browser can send: which sample user to show. Anything else is rejected.
const userQuery = z.enum(USERS.map((user) => user.id) as [string, ...string[]]);
const payBody = z.object({ user: userQuery }).strict();
const simulateBody = z.object({ shoppers: z.number().int().min(1).max(SIMULATION.maxShoppers) }).strict();

const SECURITY_HEADERS = {
  // Scripts, styles and connections may only come from this app itself: no inline code, no third parties.
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

/** What one browser is told. Decisions only: never the flag rules, and never the API key. */
export function snapshotFor(flags: FlagSource, user: DemoUser, featuredFlag: string) {
  const all = flags.allFlags(user.context); // listing flags is not showing them: no exposures here
  const status = flags.status;
  // The checkout IS shown to this viewer, so asking for the featured flag this way records an
  // experiment exposure (once per user; repeat pushes change nothing).
  const featured = all[featuredFlag] === undefined ? undefined : flags.evaluate(featuredFlag, user.context);
  return {
    user: { id: user.id, name: user.name, attributes: user.context.attributes ?? {} },
    featured: { key: featuredFlag, exists: featured !== undefined, value: featured?.value ?? false },
    flags: Object.entries(all)
      .map(([key, detail]) => ({ key, value: detail.value, reason: detail.reason, ...(detail.ruleId ? { ruleId: detail.ruleId } : {}) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    sdk: { ready: status.ready, source: status.source, stream: status.stream, degraded: status.streamDegraded, version: status.version ?? null, fatal: status.fatal, events: status.events },
    at: Date.now(),
  };
}

/**
 * The demo app: a pretend shop whose checkout depends on a feature flag.
 *
 * The important part is where things run. The API key and the SDK live HERE, on the server. A flag
 * check is a function call on data the SDK already holds, so serving a page costs no network call
 * to FlagForge. The browser only ever receives the answers ("one-tap checkout: yes, because rule
 * X matched"), pushed over a stream whenever the SDK says the flags changed.
 */
export function createDemoApp({ flags, featuredFlag, heartbeatMs = 20_000, statusCheckMs = 1_000, maxConnections = 100, random = Math.random }: DemoAppOptions) {
  const connections = new Set<{ user: DemoUser; send: (event: string, data: unknown) => void; end: () => void }>();

  const broadcast = () => {
    for (const connection of connections) connection.send("snapshot", snapshotFor(flags, connection.user, featuredFlag));
  };
  const stopListening = flags.on("update", broadcast);

  // The SDK reports flag changes with an event but not connection changes, so those are polled.
  let lastStatus = JSON.stringify(flags.status);
  const statusTimer = setInterval(() => {
    const now = JSON.stringify(flags.status);
    if (now === lastStatus) return;
    lastStatus = now;
    broadcast();
  }, statusCheckMs);
  statusTimer.unref();

  const text = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": `${type}; charset=utf-8` });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => text(res, status, "application/json", JSON.stringify(body));

  /** Reads a small JSON body. Anything large, malformed or not JSON is rejected before it is parsed. */
  function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
    return new Promise((resolve) => {
      if (!/^application\/json(\s*;|$)/i.test(req.headers["content-type"] ?? "")) return resolve({ ok: false, status: 415, error: "Send JSON (Content-Type: application/json)" });
      // A page on another website can make a browser send a POST here, but cannot set this header
      // without a preflight, which this app never answers. The Origin check closes the same gap
      // for browsers that send it.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return resolve({ ok: false, status: 403, error: "Cross-origin request refused" });
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2048) {
          resolve({ ok: false, status: 413, error: "Body too large" });
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          resolve({ ok: false, status: 400, error: "Body is not valid JSON" });
        }
      });
      req.on("error", () => resolve({ ok: false, status: 400, error: "Could not read the request" }));
    });
  }

  /** "Pay" was pressed by this sample customer: the shopper converted. */
  async function pay(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    if (!body.ok) return json(res, body.status, { error: body.error });
    const parsed = payBody.safeParse(body.value);
    const user = parsed.success ? findUser(parsed.data.user) : undefined;
    if (!user) return json(res, 400, { error: "Unknown user" });
    const shown = flags.evaluate(featuredFlag, user.context); // makes sure this user counts as shown a variant
    flags.track(CONVERSION_EVENT, user.context);
    json(res, 200, { user: user.id, paid: true, oneTap: shown.value, event: CONVERSION_EVENT });
  }

  let simulationRuns = 0;
  /**
   * Sends pretend traffic: each shopper is shown the checkout and, with a made-up probability that
   * depends on which one they got, pays. Real SDK calls, so the events reach FlagForge exactly as
   * from real shoppers.
   */
  async function simulate(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    if (!body.ok) return json(res, body.status, { error: body.error });
    const parsed = simulateBody.safeParse(body.value);
    if (!parsed.success) return json(res, 400, { error: `shoppers must be a whole number from 1 to ${SIMULATION.maxShoppers}` });
    const run = `${Date.now().toString(36)}-${++simulationRuns}`;
    const plans = ["free", "free", "pro", "team"];
    const countries = ["NO", "SE", "DK", "DE", "PL", "GB"];
    let withFlag = 0;
    let conversions = 0;
    for (let i = 0; i < parsed.data.shoppers; i++) {
      const shopper: EvaluationContext = { key: `sim-${run}-${i}`, attributes: { plan: plans[Math.floor(random() * plans.length)]!, country: countries[Math.floor(random() * countries.length)]! } };
      const has = flags.evaluate(featuredFlag, shopper).value;
      if (has) withFlag++;
      if (random() < (has ? SIMULATION.conversionWith : SIMULATION.conversionWithout)) {
        flags.track(CONVERSION_EVENT, shopper);
        conversions++;
      }
    }
    json(res, 200, { shoppers: parsed.data.shoppers, withFlag, withoutFlag: parsed.data.shoppers - withFlag, conversions });
  }

  function events(req: IncomingMessage, res: ServerResponse, url: URL) {
    const parsed = userQuery.safeParse(url.searchParams.get("user"));
    const user = parsed.success ? findUser(parsed.data) : undefined;
    if (!user) return json(res, 400, { error: "Unknown user" });
    if (connections.size >= maxConnections) return json(res, 503, { error: "Too many viewers" });

    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), heartbeatMs);
    heartbeat.unref();
    const connection = {
      user,
      send,
      end: () => {
        clearInterval(heartbeat);
        connections.delete(connection);
        if (!res.writableEnded) res.end();
      },
    };
    connections.add(connection);
    req.on("close", connection.end);
    send("snapshot", snapshotFor(flags, user, featuredFlag));
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://demo.local");
    if (req.method === "POST" && (url.pathname === "/pay" || url.pathname === "/simulate")) return void (url.pathname === "/pay" ? pay(req, res) : simulate(req, res));
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
    switch (url.pathname) {
      case "/":
        return text(res, 200, "text/html", PAGE_HTML);
      case "/app.js":
        return text(res, 200, "text/javascript", APP_JS);
      case "/app.css":
        return text(res, 200, "text/css", APP_CSS);
      case "/api/config":
        return json(res, 200, { users: USERS.map((u) => ({ id: u.id, name: u.name, attributes: u.context.attributes ?? {} })), featuredFlag, conversionEvent: CONVERSION_EVENT, simulation: SIMULATION });
      case "/health":
        return json(res, flags.status.ready ? 200 : 503, { status: flags.status.ready ? "ok" : "waiting for flags", stream: flags.status.stream });
      case "/events":
        return events(req, res, url);
      default:
        return json(res, 404, { error: "Not found" });
    }
  });

  return {
    server,
    get viewers() {
      return connections.size;
    },
    /** Ends every open stream so the HTTP server can stop. */
    close() {
      clearInterval(statusTimer);
      stopListening();
      for (const connection of [...connections]) connection.end();
    },
  };
}
