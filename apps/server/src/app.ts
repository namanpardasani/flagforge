import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createApiKeyService } from "./apikeys/service.js";
import { createAuthService } from "./auth/service.js";
import { createMailer, type Mailer } from "./mail/index.js";
import { createExperimentService } from "./experiments/service.js";
import type { Config } from "./config.js";
import { createFlagService } from "./flags/service.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { clientIp, fingerprint, rateLimit } from "./middleware/rate-limit.js";
import { requestLogger } from "./middleware/request-logger.js";
import { createProjectService } from "./projects/service.js";
import { defaultLimits, type RateLimits } from "./rate-limits.js";
import { createRealtime, type Realtime } from "./realtime/index.js";
import { createRedisServices, type RedisServices } from "./redis/index.js";
import { apiKeysRouter } from "./routes/api-keys.js";
import { authRouter } from "./routes/auth.js";
import { experimentsRouter } from "./routes/experiments.js";
import { flagsRouter } from "./routes/flags.js";
import { scheduleRouter } from "./routes/schedule.js";
import { createScheduleService, type ScheduleService } from "./schedule/service.js";
import { healthRouter, type DatabaseCheck } from "./routes/health.js";
import { projectsRouter } from "./routes/projects.js";
import { sdkRouter } from "./routes/sdk.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { createWorkspaceService } from "./workspaces/service.js";

export interface AppDeps {
  logger: Logger;
  config: Config;
  prisma: PrismaClient;
  checkDatabase: DatabaseCheck;
  /** Cache, rate limiter and event bus. Without it the app runs fully in-memory (no Redis needed). */
  redis?: RedisServices;
  /** Event bus + SSE streams. Created automatically when omitted; pass one to control shutdown. */
  realtime?: Realtime;
  /** Sends verification and reset emails. Created from the configuration when omitted. */
  mailer?: Mailer;
  /** Override rate limits (tests use this). */
  limits?: Partial<RateLimits>;
}

/** Builds the Express app without listening on a port, so tests can import it. */
export function createApp({ logger, config, prisma, checkDatabase, redis, realtime, mailer, limits: limitOverrides }: AppDeps) {
  const services = redis ?? createRedisServices({ REDIS_URL: undefined, RATE_LIMIT_ENABLED: config.RATE_LIMIT_ENABLED });
  const rt = realtime ?? createRealtime(prisma, config, services.bus);
  const limits: RateLimits = { ...defaultLimits, ...limitOverrides };

  const app = express();
  // Behind a reverse proxy every request seems to come from the proxy's IP unless Express is told how
  // many proxies to trust. Without this, rate limits would treat all users as one.
  app.set("trust proxy", config.TRUST_PROXY);
  // Never advertise the framework.
  app.disable("x-powered-by");

  app.use(requestLogger(logger));
  app.use(helmet());
  // Which websites may call this API from a browser. Server-to-server callers (the SDK) are not
  // affected: CORS is enforced by browsers only. It is not an access control by itself (every route
  // still needs a token or an API key); it stops other sites from using a visitor's browser to call us.
  const allowAnyOrigin = config.CORS_ORIGINS.length === 0 && config.NODE_ENV !== "production";
  app.use(
    cors({
      origin: allowAnyOrigin ? true : config.CORS_ORIGINS,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Authorization", "Content-Type", "Accept"],
      maxAge: 600, // browsers may cache the preflight answer for ten minutes
    }),
  );

  // Per-IP limit for the management API. /sdk has its own per-key limits (a whole fleet can share one
  // IP), and /health must always answer for load balancers.
  const globalLimit = rateLimit(services.rateLimiter, {
    name: "global",
    rule: limits.global,
    key: (req) => fingerprint(clientIp(req)),
  });
  app.use((req, res, next) => (req.path === "/health" || req.path.startsWith("/sdk/") ? next() : globalLimit(req, res, next)));

  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter(checkDatabase, () => services.status()));
  app.use(authRouter(createAuthService(prisma, config, { mailer: mailer ?? createMailer(config, logger), logger }), config, services.rateLimiter, limits));
  app.use(workspacesRouter(createWorkspaceService(prisma), prisma, config));
  app.use(projectsRouter(createProjectService(prisma, services.keyCache), prisma, config, rt.dashboard));
  const flagService = createFlagService(prisma, { bus: rt.bus, cache: services.configCache });
  app.use(flagsRouter(flagService, prisma, config));
  const scheduled = createScheduleService(prisma, flagService, logger);
  app.use(scheduleRouter(scheduled, prisma, config));
  app.locals["scheduled"] = scheduled; // so the process that starts the server can run the scheduler
  app.use(apiKeysRouter(createApiKeyService(prisma, rt.bus, services.keyCache), prisma, config));
  const experiments = createExperimentService(prisma);
  app.use(experimentsRouter(experiments, prisma, config));
  app.use(
    sdkRouter(prisma, {
      experiments,
      streams: rt.streams,
      keyCache: services.keyCache,
      configCache: services.configCache,
      limiter: services.rateLimiter,
      limits,
    }),
  );

  // Order matters: 404 first, then the error handler must be last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** The scheduled-changes service of an app made by createApp (server.ts starts its runner). */
export const scheduledChangesOf = (app: ReturnType<typeof createApp>) => app.locals["scheduled"] as ScheduleService;
