import type { Response } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../errors.js";
import { envTopic, type BusMessage, type EventBus } from "./bus.js";

export interface DashboardStreamOptions {
  heartbeatMs: number;
  revalidateMs: number;
  maxConnections: number;
  /** One person with many tabs open; beyond this the dashboard simply falls back to refetching. */
  maxPerUser?: number;
  maxBufferedBytes?: number;
}

export interface DashboardViewer {
  userId: string;
  workspaceId: string;
  projectId: string;
  /** When the access token that opened the stream expires (ms since epoch). The stream ends then. */
  expiresAt: number;
}

interface Connection {
  viewer: DashboardViewer;
  hello: () => Promise<void>;
  degraded: () => void;
  close: () => void;
}

/**
 * The dashboard's live stream: Server-Sent Events for a signed-in USER (the SDK stream in
 * streams.ts is for API keys). One stream covers every environment of one project.
 *
 * Like the SDK stream it is only a doorbell: "environment X is now at version N". The dashboard
 * then refetches through the normal, permission-checked API. Nothing sensitive travels on the
 * stream, and a lost event cannot leave the screen wrong for long because every (re)connection
 * starts with a hello listing the current versions.
 *
 * Access is not granted forever at connect time:
 *  - the stream ends when the access token that opened it expires (the client reconnects with a
 *    fresh one), and
 *  - membership is re-checked on a timer, so someone removed from the workspace loses the stream.
 */
export class DashboardStreams {
  readonly #connections = new Map<string, Set<Connection>>();
  readonly #offHealth: () => void;
  #total = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly bus: EventBus,
    private readonly options: DashboardStreamOptions,
  ) {
    // Same rule as the SDK streams: while this instance cannot hear the others, say so; when it can
    // again, re-announce current versions because changes may have been missed in the gap.
    this.#offHealth = bus.onHealthChange((healthy) => {
      for (const set of this.#connections.values()) {
        for (const c of set) {
          if (healthy) void c.hello();
          else c.degraded();
        }
      }
    });
  }

  get connectionCount() {
    return this.#total;
  }

  /** Every query is filtered by workspaceId: a project id from another tenant "does not exist". */
  #environments(viewer: DashboardViewer) {
    return this.prisma.environment.findMany({
      where: { projectId: viewer.projectId, workspaceId: viewer.workspaceId },
      select: { id: true, key: true, configVersion: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async handle(res: Response, viewer: DashboardViewer): Promise<void> {
    const forUser = this.#connections.get(viewer.userId)?.size ?? 0;
    if (this.#total >= this.options.maxConnections || forUser >= (this.options.maxPerUser ?? 10)) {
      throw new AppError(429, "TOO_MANY_STREAMS", "Too many open streams");
    }
    // Checked before any header is written, so a wrong project still gets a normal JSON 404.
    const project = await this.prisma.project.findFirst({
      where: { id: viewer.projectId, workspaceId: viewer.workspaceId },
      select: { id: true },
    });
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    const subscribed = await this.#environments(viewer);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    return new Promise<void>((resolve) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const unsubscribes: Array<() => void> = [];
      let done = false;
      let helloSent = false;

      const finish = () => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout); // clearTimeout also clears intervals in Node
        unsubscribes.forEach((off) => off());
        const current = this.#connections.get(viewer.userId);
        current?.delete(connection);
        if (current?.size === 0) this.#connections.delete(viewer.userId);
        this.#total--;
        if (!res.writableEnded) res.end();
        resolve();
      };

      const write = (chunk: string) => {
        if (done || res.writableEnded || res.destroyed) return;
        if (res.writableLength > (this.options.maxBufferedBytes ?? 64 * 1024)) {
          res.destroy(); // slow consumer
          return;
        }
        res.write(chunk);
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      /** Reads current versions from the database and announces them. Returns what it announced. */
      const hello = async () => {
        const environments = await this.#environments(viewer);
        send("hello", { environments: environments.map((e) => ({ environmentId: e.id, key: e.key, version: e.configVersion })) });
        return new Map(environments.map((e) => [e.id, e.configVersion]));
      };

      const connection: Connection = {
        viewer,
        hello: async () => {
          if (!helloSent) return;
          try {
            await hello();
          } catch {
            // database blip: the client's own refetch-on-focus will cover it
          }
        },
        degraded: () => {
          if (helloSent) send("degraded", { degraded: true });
        },
        close: finish,
      };
      let set = this.#connections.get(viewer.userId);
      if (!set) this.#connections.set(viewer.userId, (set = new Set()));
      set.add(connection);
      this.#total++;
      res.on("close", finish);

      // Subscribe BEFORE reading versions and queue what arrives meanwhile, so a change committed
      // in between is not lost (same reasoning as the SDK stream).
      const queued: Array<{ environmentId: string; version: number }> = [];
      for (const environment of subscribed) {
        unsubscribes.push(
          this.bus.subscribe(envTopic(environment.id), (m: BusMessage) => {
            if (m.type !== "config") return;
            const change = { environmentId: m.environmentId, version: m.version };
            if (helloSent) send("change", change);
            else queued.push(change);
          }),
        );
      }

      void (async () => {
        try {
          const announced = await hello();
          helloSent = true;
          if (!this.bus.isHealthy()) connection.degraded();
          for (const change of queued.sort((a, b) => a.version - b.version)) {
            if (change.version > (announced.get(change.environmentId) ?? 0)) send("change", change);
          }
        } catch {
          return finish();
        }

        timers.push(setInterval(() => write(": ping\n\n"), this.options.heartbeatMs));

        // The token that opened this stream is only valid until `expiresAt`; do not outlive it.
        timers.push(setTimeout(finish, Math.max(0, viewer.expiresAt - Date.now())));

        let checking = false;
        timers.push(
          setInterval(async () => {
            if (checking) return;
            checking = true;
            try {
              const member = await this.prisma.workspaceMember.findUnique({
                where: { workspaceId_userId: { workspaceId: viewer.workspaceId, userId: viewer.userId } },
                select: { role: true },
              });
              const stillThere = member
                ? await this.prisma.project.findFirst({ where: { id: viewer.projectId, workspaceId: viewer.workspaceId }, select: { id: true } })
                : null;
              if (!stillThere) finish();
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

  closeAll(): void {
    for (const set of [...this.#connections.values()]) for (const c of [...set]) c.close();
  }

  dispose(): void {
    this.#offHealth();
  }
}
