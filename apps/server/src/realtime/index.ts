import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Config } from "../config.js";
import { InMemoryEventBus, type EventBus } from "./bus.js";
import { DashboardStreams } from "./dashboard-streams.js";
import { StreamManager } from "./streams.js";

export interface Realtime {
  bus: EventBus;
  streams: StreamManager;
  /** Live updates for signed-in dashboard users (JWT), separate from the SDK streams (API key). */
  dashboard: DashboardStreams;
  /** Ends all streams and releases the bus. Call on shutdown. */
  close(): Promise<void>;
}

export function createRealtime(prisma: PrismaClient, config: Config, bus: EventBus = new InMemoryEventBus()): Realtime {
  const streams = new StreamManager(prisma, bus, {
    heartbeatMs: config.SSE_HEARTBEAT_MS,
    revalidateMs: config.SSE_REVALIDATE_MS,
    maxConnections: config.SSE_MAX_CONNECTIONS,
    maxPerKey: config.SSE_MAX_CONNECTIONS_PER_KEY,
  });
  const dashboard = new DashboardStreams(prisma, bus, {
    heartbeatMs: config.SSE_HEARTBEAT_MS,
    revalidateMs: config.SSE_REVALIDATE_MS,
    maxConnections: config.SSE_MAX_CONNECTIONS,
  });
  return {
    bus,
    streams,
    dashboard,
    async close() {
      streams.closeAll();
      streams.dispose();
      dashboard.closeAll();
      dashboard.dispose();
      await bus.close();
    },
  };
}
