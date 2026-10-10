import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConfigSnapshot } from "../src/index.js";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

/** A fake FlagForge server whose behaviour tests can change on the fly (and switch off and on again). */
export class StubServer {
  requests: RecordedRequest[] = [];
  status = 200;
  /** Sent as-is when set (to simulate garbage responses). Otherwise `snapshot` is sent as JSON. */
  rawBody: string | undefined;
  snapshot: unknown;
  etag: string | undefined = '"v1"';
  delayMs = 0;

  // ---- real-time stream (GET /sdk/v1/stream) ----
  /** Open SSE connections. */
  streams: ServerResponse[] = [];
  /** Non-200 makes the stream endpoint refuse connections. */
  streamStatus = 200;
  /** Version sent in the hello event. Defaults to the snapshot's version. */
  helloVersion: number | undefined;
  /** When > 0, every stream gets a ": ping" comment this often. */
  heartbeatMs = 0;
  /** Skip the hello event entirely. */
  skipHello = false;
  #timers = new Map<ServerResponse, ReturnType<typeof setInterval>>();
  #server: Server | undefined;
  #port = 0;

  constructor(snapshot: ConfigSnapshot) {
    this.snapshot = snapshot;
  }

  get url() {
    return `http://127.0.0.1:${this.#port}`;
  }

  async start() {
    const server = createServer((req, res) => {
      this.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      if (req.url === "/sdk/v1/stream") return this.#openStream(res);
      const respond = () => {
        if (this.status !== 200) {
          res.writeHead(this.status, { "content-type": "text/plain" }).end("error");
        } else if (this.etag && req.headers["if-none-match"] === this.etag && this.rawBody === undefined) {
          res.writeHead(304, { etag: this.etag }).end();
        } else {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (this.etag) headers["etag"] = this.etag;
          res.writeHead(200, headers).end(this.rawBody ?? JSON.stringify(this.snapshot));
        }
      };
      if (this.delayMs > 0) setTimeout(respond, this.delayMs);
      else respond();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#port, "127.0.0.1", resolve);
    });
    this.#port = (server.address() as AddressInfo).port;
    this.#server = server;
  }

  get flagRequests() {
    return this.requests.filter((r) => r.url === "/sdk/v1/flags");
  }

  get streamRequests() {
    return this.requests.filter((r) => r.url === "/sdk/v1/stream");
  }

  #openStream(res: ServerResponse) {
    if (this.streamStatus !== 200) {
      res.writeHead(this.streamStatus, { "content-type": "text/plain" }).end("no stream");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("retry: 3000\n\n");
    const version = this.helloVersion ?? (this.snapshot as { version?: number }).version ?? 0;
    if (!this.skipHello) res.write(`event: hello\nid: ${version}\ndata: ${JSON.stringify({ version })}\n\n`);
    this.streams.push(res);
    if (this.heartbeatMs > 0) this.#timers.set(res, setInterval(() => res.write(": ping\n\n"), this.heartbeatMs));
    res.on("close", () => {
      this.streams = this.streams.filter((s) => s !== res);
      clearInterval(this.#timers.get(res));
      this.#timers.delete(res);
    });
  }

  /** Pushes a change event to every open stream. */
  sendChange(version: number) {
    this.sendRaw(`event: change\nid: ${version}\ndata: ${JSON.stringify({ version })}\n\n`);
  }

  sendRaw(text: string) {
    for (const res of this.streams) res.write(text);
  }

  /** Closes every open stream from the server side (like a deploy or a dropped connection). */
  dropStreams() {
    for (const res of [...this.streams]) res.end();
  }

  /** Simulates an outage. The port is remembered so start() can bring the "same" server back. */
  async stop() {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    for (const t of this.#timers.values()) clearInterval(t);
    this.#timers.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export const snap = (flags: ConfigSnapshot["flags"], envKey = "dev"): ConfigSnapshot => ({
  environment: { id: `env-${envKey}`, key: envKey },
  flags,
});

export const flag = (
  key: string,
  overrides: Partial<ConfigSnapshot["flags"][number]> = {},
): ConfigSnapshot["flags"][number] => ({ key, enabled: true, rules: [], fallthroughBps: 10000, ...overrides });
