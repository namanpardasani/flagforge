import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
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

  /** Simulates an outage. The port is remembered so start() can bring the "same" server back. */
  async stop() {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
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
