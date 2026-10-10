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
  environmentId: string;
  workspaceId: string;
  /** Re-announce the current version (used after the bus may have missed events). */
  hello: (version: number) => void;
  /** Tell the SDK this instance can no longer hear other instances, so it should poll normally. */
  degraded: () => void;
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
  readonly #offHealth: () => void;
  #total = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly bus: EventBus,
    private readonly options: StreamOptions,
  ) {
    // While this instance cannot hear other instances (Redis connection down), tell SDKs so they stop
    // relying on the stream and poll at the normal rate. When it is back, events may have been missed
    // in the gap, so re-announce the current version: SDKs compare it with theirs and refetch only if
    // they really missed something. (The hello also clears their "degraded" flag.)
    this.#offHealth = bus.onHealthChange((healthy) => {
      if (healthy) void this.#resync();
      else for (const set of this.#connections.values()) for (const c of set) c.degraded();
    });
  }

  async #resync() {
    const byEnvironment = new Map<string, { workspaceId: string; connections: Connection[] }>();
    for (const set of this.#connections.values()) {
      for (const c of set) {
        const entry = byEnvironment.get(c.environmentId) ?? { workspaceId: c.workspaceId, connections: [] };
        entry.connections.push(c);
        byEnvironment.set(c.environmentId, entry);
      }
    }
    for (const [environmentId, { workspaceId, connections }] of byEnvironment) {
      try {
        const env = await this.prisma.environment.findFirst({
          where: { id: environmentId, workspaceId },
          select: { configVersion: true },
        });
        if (env) for (const c of connections) c.hello(env.configVersion);
      } catch {
        // database blip: the next heartbeat/poll will catch these clients up
      }
    }
  }

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

      let resyncHello: (version: number) => void = () => {};
      let notifyDegraded: () => void = () => {};
      const connection: Connection = {
        apiKeyId: sdk.apiKeyId,
        environmentId: sdk.environmentId,
        workspaceId: sdk.workspaceId,
        hello: (version) => resyncHello(version),
        degraded: () => notifyDegraded(),
        close: () => finish(),
      };
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
      resyncHello = (version) => {
        if (helloSent) sendVersion("hello", version);
      };
      notifyDegraded = () => {
        if (helloSent) write(`event: degraded\ndata: {"degraded":true}\n\n`);
      };
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
          if (!this.bus.isHealthy()) notifyDegraded(); // connected while the event feed is already broken
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

  /** Stops listening to the bus. Call once, when the manager is being discarded. */
  dispose(): void {
    this.#offHealth();
  }
}
