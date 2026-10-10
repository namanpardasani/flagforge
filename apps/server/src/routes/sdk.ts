import { createHash } from "node:crypto";
import { evaluateFlag } from "@flagforge/core";
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../errors.js";
import { clientIp, fingerprint, rateLimit } from "../middleware/rate-limit.js";
import { requireApiKey } from "../middleware/require-api-key.js";
import type { RateLimits } from "../rate-limits.js";
import type { ConfigCache } from "../redis/config-cache.js";
import type { KeyCache } from "../redis/key-cache.js";
import type { RateLimiter } from "../redis/rate-limit.js";
import type { StreamManager } from "../realtime/streams.js";
import { validate } from "../middleware/validate.js";
import { loadFlagConfig, loadFlagConfigs } from "../sdk/configs.js";
import { evaluateAllSchema, evaluateSchema } from "../sdk/schemas.js";

/**
 * Does the client's If-None-Match header match this ETag? Handles weak validators (W/"x"),
 * comma-separated lists and "*". Written by hand because Express's built-in check gives up whenever
 * the client sends Cache-Control: no-cache, which Node's fetch adds automatically to conditional requests.
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

const etagOf = (body: string) => `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;

/** Sends a JSON body with its ETag, answering 304 (no body) when the client already has it. */
function sendWithEtag(req: Request, res: Response, body: string, etag: string) {
  res.set("ETag", etag);
  res.set("Cache-Control", "private, no-cache"); // clients may keep a copy but must revalidate every time
  if (etagMatches(req.headers["if-none-match"], etag)) {
    res.status(304).end();
    return;
  }
  res.type("json").send(body);
}

/**
 * Endpoints called by server-side SDKs, authenticated with an environment API key (not a user JWT).
 * The key fixes the tenant, project and environment, so nothing here accepts those from the client.
 */
export interface SdkDeps {
  streams: StreamManager;
  keyCache: KeyCache;
  configCache: ConfigCache;
  limiter: RateLimiter;
  limits: RateLimits;
}

export function sdkRouter(prisma: PrismaClient, { streams, keyCache, configCache, limiter, limits }: SdkDeps): Router {
  const router = Router();
  const apiKey = requireApiKey(prisma, keyCache);
  // Cheap guard BEFORE any database work, so floods of bad keys cannot hammer Postgres.
  const perIp = rateLimit(limiter, { name: "sdk-ip", rule: limits.sdkPerIp, key: (req) => fingerprint(clientIp(req)) });
  const perKey = (name: string, rule: RateLimits["sdkFlags"]) =>
    rateLimit(limiter, { name, rule, key: (req) => req.sdk?.apiKeyId });

  // The full configuration, so an SDK can cache it and evaluate locally with @flagforge/core.
  router.get("/sdk/v1/flags", perIp, apiKey, perKey("sdk-flags", limits.sdkFlags), async (req, res) => {
    const { environmentId, environmentKey, workspaceId } = req.sdk!;

    // Cache hit: no database work at all. The cache only returns entries that are still current.
    const cached = await configCache.get(environmentId);
    if (cached) return sendWithEtag(req, res, cached.body, cached.etag);
    // Read the version BEFORE the flags. If a change lands in between, the flags are newer than the
    // version we report, so the SDK just refetches once more. Reading in the other order could label
    // old flags with a new version, and the SDK would then never fetch the change.
    const env = await prisma.environment.findFirst({
      where: { id: environmentId, workspaceId },
      select: { configVersion: true },
    });
    if (!env) throw new AppError(401, "INVALID_API_KEY", "Missing, invalid or revoked API key");
    const body = JSON.stringify({
      environment: { id: environmentId, key: environmentKey },
      version: env.configVersion,
      flags: await loadFlagConfigs(prisma, req.sdk!),
    });
    const etag = etagOf(body);
    // The cache refuses this write if a newer version was announced while we were reading.
    await configCache.put(environmentId, { version: env.configVersion, etag, body });
    sendWithEtag(req, res, body, etag);
  });

  // Real-time doorbell: tells the SDK "your environment is now at version N" (see StreamManager).
  router.get("/sdk/v1/stream", perIp, apiKey, perKey("sdk-stream", limits.sdkStream), (req, res) => streams.handle(req, res));

  // Server-side evaluation of one flag, for clients that do not want to run the engine themselves.
  router.post("/sdk/v1/evaluate", perIp, apiKey, perKey("sdk-evaluate", limits.sdkEvaluate), validate(evaluateSchema), async (req, res) => {
    const config = await loadFlagConfig(prisma, req.sdk!, req.body.flagKey);
    if (!config) throw new AppError(404, "FLAG_NOT_FOUND", "Flag not found");
    res.json({ flagKey: config.key, ...evaluateFlag(config, req.body.context) });
  });

  router.post("/sdk/v1/evaluate-all", perIp, apiKey, perKey("sdk-evaluate", limits.sdkEvaluate), validate(evaluateAllSchema), async (req, res) => {
    const configs = await loadFlagConfigs(prisma, req.sdk!);
    const flags = Object.fromEntries(configs.map((c) => [c.key, evaluateFlag(c, req.body.context)]));
    res.json({ flags });
  });

  return router;
}
