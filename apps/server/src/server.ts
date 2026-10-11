import { pino } from "pino";
import { createApp, scheduledChangesOf } from "./app.js";
import { loadConfig } from "./config.js";
import { createRealtime } from "./realtime/index.js";
import { startScheduler } from "./schedule/service.js";
import { createRedisServices } from "./redis/index.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

// Imported after config validation so a bad env gives the clear config error first.
const { prisma } = await import("./db.js");

const redis = createRedisServices(config);
const realtime = createRealtime(prisma, config, redis.bus);
if (redis.enabled) logger.info("redis enabled: config cache, shared rate limits and cross-instance events");
else logger.warn("REDIS_URL not set: running without cache; rate limits and events are per-instance");

const app = createApp({
  logger,
  config,
  prisma,
  redis,
  realtime,
  checkDatabase: async () => {
    await prisma.$queryRaw`SELECT 1`;
  },
});

// Applies planned flag changes when they fall due, and catches up on any that fell due while this
// process was asleep or restarting.
const scheduler = startScheduler(scheduledChangesOf(app), logger);

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "server listening");
});

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await scheduler.stop();
    await realtime.close();
    await redis.close();
    await prisma.$disconnect();
    process.exit(0);
  });
  // Open SSE streams never finish on their own, so end them or server.close() would wait forever.
  void realtime.close();
  setTimeout(() => server.closeAllConnections(), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
