import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Config } from "../config.js";
import { InMemoryEventBus, type EventBus } from "./bus.js";
import { StreamManager } from "./streams.js";

export interface Realtime {
  bus: EventBus;
  streams: StreamManager;
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
  return {
    bus,
    streams,
    async close() {
      streams.closeAll();
      await bus.close();
    },
  };
}
