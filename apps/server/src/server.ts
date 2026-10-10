import { pino } from "pino";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRealtime } from "./realtime/index.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

// Imported after config validation so a bad env gives the clear config error first.
const { prisma } = await import("./db.js");

const realtime = createRealtime(prisma, config);

const app = createApp({
  logger,
  config,
  prisma,
  realtime,
  checkDatabase: async () => {
    await prisma.$queryRaw`SELECT 1`;
  },
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "server listening");
});

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await realtime.close();
    await prisma.$disconnect();
    process.exit(0);
  });
  // Open SSE streams never finish on their own, so end them or server.close() would wait forever.
  void realtime.close();
  setTimeout(() => server.closeAllConnections(), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
