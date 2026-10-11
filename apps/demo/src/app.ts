import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ClientStatus, EvaluationDetail, EvaluationContext } from "@flagforge/sdk";
import { z } from "zod";
import { APP_CSS, APP_JS, PAGE_HTML } from "./page.js";
import { findUser, USERS, type DemoUser } from "./users.js";

/** The part of the SDK client this app uses. Declaring it lets tests pass in a stand-in. */
export interface FlagSource {
  allFlags(user: EvaluationContext): Record<string, EvaluationDetail>;
  readonly status: ClientStatus;
  on(event: "update", listener: () => void): () => void;
}

export interface DemoAppOptions {
  flags: FlagSource;
  /** The flag that switches the mock checkout. */
  featuredFlag: string;
  heartbeatMs?: number;
  /** How often to look for a change in the SDK's connection status (it has no event for that). */
  statusCheckMs?: number;
  maxConnections?: number;
}

// The only input a browser can send: which sample user to show. Anything else is rejected.
const userQuery = z.enum(USERS.map((user) => user.id) as [string, ...string[]]);

const SECURITY_HEADERS = {
  // Scripts, styles and connections may only come from this app itself: no inline code, no third parties.
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

/** What one browser is told. Decisions only: never the flag rules, and never the API key. */
export function snapshotFor(flags: FlagSource, user: DemoUser, featuredFlag: string) {
  const all = flags.allFlags(user.context);
  const status = flags.status;
  const featured = all[featuredFlag];
  return {
    user: { id: user.id, name: user.name, attributes: user.context.attributes ?? {} },
    featured: { key: featuredFlag, exists: featured !== undefined, value: featured?.value ?? false },
    flags: Object.entries(all)
      .map(([key, detail]) => ({ key, value: detail.value, reason: detail.reason, ...(detail.ruleId ? { ruleId: detail.ruleId } : {}) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    sdk: { ready: status.ready, source: status.source, stream: status.stream, degraded: status.streamDegraded, version: status.version ?? null, fatal: status.fatal },
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
export function createDemoApp({ flags, featuredFlag, heartbeatMs = 20_000, statusCheckMs = 1_000, maxConnections = 100 }: DemoAppOptions) {
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
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "This demo only answers GET" });
    switch (url.pathname) {
      case "/":
        return text(res, 200, "text/html", PAGE_HTML);
      case "/app.js":
        return text(res, 200, "text/javascript", APP_JS);
      case "/app.css":
        return text(res, 200, "text/css", APP_CSS);
      case "/api/config":
        return json(res, 200, { users: USERS.map((u) => ({ id: u.id, name: u.name, attributes: u.context.attributes ?? {} })), featuredFlag });
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
