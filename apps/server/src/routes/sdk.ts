import { evaluateFlag } from "@flagforge/core";
import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../errors.js";
import { requireApiKey } from "../middleware/require-api-key.js";
import { validate } from "../middleware/validate.js";
import { loadFlagConfig, loadFlagConfigs } from "../sdk/configs.js";
import { evaluateAllSchema, evaluateSchema } from "../sdk/schemas.js";

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
    res.json({
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
