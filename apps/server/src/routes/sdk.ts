import { createHash } from "node:crypto";
import { evaluateFlag } from "@flagforge/core";
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../errors.js";
import { requireApiKey } from "../middleware/require-api-key.js";
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

/** Sends JSON with a content-derived ETag, answering 304 (no body) when the client already has it. */
function sendConditionalJson(req: Request, res: Response, payload: unknown) {
  const body = JSON.stringify(payload);
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
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
export function sdkRouter(prisma: PrismaClient): Router {
  const router = Router();
  const apiKey = requireApiKey(prisma);

  // The full configuration, so an SDK can cache it and evaluate locally with @flagforge/core.
  router.get("/sdk/v1/flags", apiKey, async (req, res) => {
    const { environmentId, environmentKey } = req.sdk!;
    sendConditionalJson(req, res, {
      environment: { id: environmentId, key: environmentKey },
      flags: await loadFlagConfigs(prisma, req.sdk!),
    });
  });

  // Server-side evaluation of one flag, for clients that do not want to run the engine themselves.
  router.post("/sdk/v1/evaluate", apiKey, validate(evaluateSchema), async (req, res) => {
    const config = await loadFlagConfig(prisma, req.sdk!, req.body.flagKey);
    if (!config) throw new AppError(404, "FLAG_NOT_FOUND", "Flag not found");
    res.json({ flagKey: config.key, ...evaluateFlag(config, req.body.context) });
  });

  router.post("/sdk/v1/evaluate-all", apiKey, validate(evaluateAllSchema), async (req, res) => {
    const configs = await loadFlagConfigs(prisma, req.sdk!);
    const flags = Object.fromEntries(configs.map((c) => [c.key, evaluateFlag(c, req.body.context)]));
    res.json({ flags });
  });

  return router;
}
