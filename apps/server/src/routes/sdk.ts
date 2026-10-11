import { createHash } from "node:crypto";
import { evaluateFlag, type FlagConfig } from "@flagforge/core";
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
import { loadFlagConfigs } from "../sdk/configs.js";
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

  /**
   * The environment's whole configuration as the JSON the SDK downloads, plus its ETag.
   * Cache hit: no database work at all (the cache only returns entries that are still current).
   * Miss: read from PostgreSQL and offer the result to the cache.
   */
  async function currentConfig(sdk: NonNullable<Request["sdk"]>): Promise<{ body: string; etag: string }> {
    const cached = await configCache.get(sdk.environmentId);
    if (cached) return cached;
    // Read the version BEFORE the flags. If a change lands in between, the flags are newer than the
    // version we report, so the SDK just refetches once more. Reading in the other order could label
    // old flags with a new version, and the SDK would then never fetch the change.
    const env = await prisma.environment.findFirst({
      where: { id: sdk.environmentId, workspaceId: sdk.workspaceId },
      select: { configVersion: true },
    });
    if (!env) throw new AppError(401, "INVALID_API_KEY", "Missing, invalid or revoked API key");
    const body = JSON.stringify({
      environment: { id: sdk.environmentId, key: sdk.environmentKey },
      version: env.configVersion,
      flags: await loadFlagConfigs(prisma, sdk),
    });
    const etag = etagOf(body);
    // The cache refuses this write if a newer version was announced while we were reading.
    await configCache.put(sdk.environmentId, { version: env.configVersion, etag, body });
    return { body, etag };
  }

  // Parsing the JSON on every evaluation would waste CPU, so the parsed form is kept per
  // environment and reused for as long as the ETag (a hash of the content) stays the same.
  // Bounded so a server with very many environments cannot grow this without limit.
  const PARSED_LIMIT = 500;
  const parsed = new Map<string, { etag: string; flags: Map<string, FlagConfig> }>();

  /**
   * The flags to evaluate against, from the SAME source as GET /sdk/v1/flags. Server-side
   * evaluation therefore answers exactly what a polling SDK would compute, with the same
   * freshness, and a warmed environment costs no database query per evaluation.
   */
  async function flagsFor(sdk: NonNullable<Request["sdk"]>): Promise<Map<string, FlagConfig>> {
    const { body, etag } = await currentConfig(sdk);
    const known = parsed.get(sdk.environmentId);
    if (known?.etag === etag) return known.flags;
    const flags = new Map((JSON.parse(body) as { flags: FlagConfig[] }).flags.map((flag) => [flag.key, flag]));
    parsed.delete(sdk.environmentId); // re-insert at the end: the Map then drops the least recently refreshed first
    parsed.set(sdk.environmentId, { etag, flags });
    if (parsed.size > PARSED_LIMIT) parsed.delete(parsed.keys().next().value!);
    return flags;
  }

  // The full configuration, so an SDK can cache it and evaluate locally with @flagforge/core.
  router.get("/sdk/v1/flags", perIp, apiKey, perKey("sdk-flags", limits.sdkFlags), async (req, res) => {
    const { body, etag } = await currentConfig(req.sdk!);
    sendWithEtag(req, res, body, etag);
  });

  // Real-time doorbell: tells the SDK "your environment is now at version N" (see StreamManager).
  router.get("/sdk/v1/stream", perIp, apiKey, perKey("sdk-stream", limits.sdkStream), (req, res) => streams.handle(req, res));

  // Server-side evaluation of one flag, for clients that do not want to run the engine themselves.
  router.post("/sdk/v1/evaluate", perIp, apiKey, perKey("sdk-evaluate", limits.sdkEvaluate), validate(evaluateSchema), async (req, res) => {
    const config = (await flagsFor(req.sdk!)).get(req.body.flagKey);
    if (!config) throw new AppError(404, "FLAG_NOT_FOUND", "Flag not found");
    res.json({ flagKey: config.key, ...evaluateFlag(config, req.body.context) });
  });

  router.post("/sdk/v1/evaluate-all", perIp, apiKey, perKey("sdk-evaluate", limits.sdkEvaluate), validate(evaluateAllSchema), async (req, res) => {
    const flags = Object.fromEntries([...(await flagsFor(req.sdk!)).values()].map((c) => [c.key, evaluateFlag(c, req.body.context)]));
    res.json({ flags });
  });

  return router;
}
