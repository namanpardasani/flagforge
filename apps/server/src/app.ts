import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
import { healthRouter, type DatabaseCheck } from "./routes/health.js";

export interface AppDeps {
  logger: Logger;
  checkDatabase: DatabaseCheck;
}

/** Builds the Express app without listening on a port, so tests can import it. */
export function createApp({ logger, checkDatabase }: AppDeps) {
  const app = express();

  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter(checkDatabase));

  // Order matters: 404 first, then the error handler must be last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
