import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createApiKeyService } from "./apikeys/service.js";
import { createAuthService } from "./auth/service.js";
import type { Config } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
import { createFlagService } from "./flags/service.js";
import { createProjectService } from "./projects/service.js";
import { apiKeysRouter } from "./routes/api-keys.js";
import { authRouter } from "./routes/auth.js";
import { flagsRouter } from "./routes/flags.js";
import { projectsRouter } from "./routes/projects.js";
import { sdkRouter } from "./routes/sdk.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { createWorkspaceService } from "./workspaces/service.js";
import { healthRouter, type DatabaseCheck } from "./routes/health.js";

export interface AppDeps {
  logger: Logger;
  config: Config;
  prisma: PrismaClient;
  checkDatabase: DatabaseCheck;
}

/** Builds the Express app without listening on a port, so tests can import it. */
export function createApp({ logger, config, prisma, checkDatabase }: AppDeps) {
  const app = express();

  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter(checkDatabase));
  app.use(authRouter(createAuthService(prisma, config), config));
  app.use(workspacesRouter(createWorkspaceService(prisma), prisma, config));
  app.use(projectsRouter(createProjectService(prisma), prisma, config));
  app.use(flagsRouter(createFlagService(prisma), prisma, config));
  app.use(apiKeysRouter(createApiKeyService(prisma), prisma, config));
  app.use(sdkRouter(prisma));

  // Order matters: 404 first, then the error handler must be last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
