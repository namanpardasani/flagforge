import type { Request, Response } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../errors.js";
import { envTopic, keyTopic, type BusMessage, type EventBus } from "./bus.js";

export interface StreamOptions {
  heartbeatMs: number;
  revalidateMs: number;
  maxConnections: number;
  maxPerKey: number;
  /** A client that lets this many bytes pile up unread is too slow; drop it. */
  maxBufferedBytes?: number;
}

interface Connection {
  apiKeyId: string;
  close: () => void;
}

/**
 * Server-Sent Events: a normal HTTP response that never ends. We write small text events to it.
 *
 * The stream is only a doorbell ("environment X is now at version N"). The SDK then fetches the real
 * config from the ETag endpoint. That keeps the database as the single source of truth, so a lost
 * or reordered event cannot corrupt anything, and every (re)connection starts with the current
 * version so a client that missed changes while offline notices immediately.
 */
export class StreamManager {
  readonly #connections = new Map<string, Set<Connection>>();
  #total = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly bus: EventBus,
    private readonly options: StreamOptions,
  ) {}

  get connectionCount() {
    return this.#total;
  }

  async handle(req: Request, res: Response): Promise<void> {
    const sdk = req.sdk!;
    const forKey = this.#connections.get(sdk.apiKeyId)?.size ?? 0;
    if (this.#total >= this.options.maxConnections || forKey >= this.options.maxPerKey) {
      throw new AppError(429, "TOO_MANY_STREAMS", "Too many open streams");
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // tell nginx-style proxies not to buffer the stream
    });
    res.write("retry: 3000\n\n"); // also flushes the headers to the client

    return new Promise<void>((resolve) => {
      const timers: ReturnType<typeof setInterval>[] = [];
      const unsubscribes: Array<() => void> = [];
      let done = false;

      const connection: Connection = { apiKeyId: sdk.apiKeyId, close: () => finish() };
      let set = this.#connections.get(sdk.apiKeyId);
      if (!set) this.#connections.set(sdk.apiKeyId, (set = new Set()));
      set.add(connection);
      this.#total++;

      const finish = () => {
        if (done) return;
        done = true;
        timers.forEach(clearInterval);
        unsubscribes.forEach((off) => off());
        const current = this.#connections.get(sdk.apiKeyId);
        current?.delete(connection);
        if (current?.size === 0) this.#connections.delete(sdk.apiKeyId);
        this.#total--;
        if (!res.writableEnded) res.end();
        resolve();
      };
      res.on("close", finish);

      const write = (chunk: string) => {
        if (done || res.writableEnded || res.destroyed) return;
        if (res.writableLength > (this.options.maxBufferedBytes ?? 64 * 1024)) {
          res.destroy(); // slow consumer: do not let it eat our memory
          return;
        }
        res.write(chunk);
      };
      const sendVersion = (event: "hello" | "change", version: number) =>
        write(`event: ${event}\nid: ${version}\ndata: ${JSON.stringify({ version })}\n\n`);

      // Subscribe BEFORE reading the current version, and queue anything that arrives meanwhile.
      // Otherwise a change committed between "read version" and "subscribe" would be lost.
      let helloSent = false;
      const queued: number[] = [];
      unsubscribes.push(
        this.bus.subscribe(envTopic(sdk.environmentId), (m: BusMessage) => {
          if (m.type !== "config") return;
          if (helloSent) sendVersion("change", m.version);
          else queued.push(m.version);
        }),
        this.bus.subscribe(keyTopic(sdk.apiKeyId), (m: BusMessage) => {
          if (m.type === "key_revoked") finish(); // revoked keys lose their streams immediately
        }),
      );

      void (async () => {
        try {
          const env = await this.prisma.environment.findFirst({
            where: { id: sdk.environmentId, workspaceId: sdk.workspaceId },
            select: { configVersion: true },
          });
          if (!env) return finish();
          sendVersion("hello", env.configVersion);
          helloSent = true;
          for (const version of queued.sort((a, b) => a - b)) {
            if (version > env.configVersion) sendVersion("change", version);
          }
        } catch {
          return finish();
        }

        timers.push(setInterval(() => write(": ping\n\n"), this.options.heartbeatMs));

        // Instances that did not see a revoke/delete event (or a missed one) still drop the stream here.
        let checking = false;
        timers.push(
          setInterval(async () => {
            if (checking) return;
            checking = true;
            try {
              const key = await this.prisma.apiKey.findFirst({
                where: { id: sdk.apiKeyId, workspaceId: sdk.workspaceId, revokedAt: null },
                select: { id: true },
              });
              if (!key) finish();
            } catch {
              // database blip: keep the stream, check again next round
            } finally {
              checking = false;
            }
          }, this.options.revalidateMs),
        );
        timers.forEach((t) => t.unref());
      })();
    });
  }

  /** Ends every stream (used on shutdown so server.close() is not held open forever by SSE). */
  closeAll(): void {
    for (const set of [...this.#connections.values()]) for (const c of [...set]) c.close();
  }
}
