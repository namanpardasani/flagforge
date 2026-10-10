import { pino } from "pino";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

// Imported after config validation so a bad env gives the clear config error first.
const { prisma } = await import("./db.js");

const app = createApp({
  logger,
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
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
