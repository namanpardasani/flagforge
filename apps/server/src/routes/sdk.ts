import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { requireApiKey } from "../middleware/require-api-key.js";

/** Endpoints called by server-side SDKs, authenticated with an environment API key (not a user JWT). */
export function sdkRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Phase 6 extends this payload with rules and rollouts; for now it is just on/off per flag.
  router.get("/sdk/v1/flags", requireApiKey(prisma), async (req, res) => {
    const { workspaceId, projectId, environmentId, environmentKey } = req.sdk!;
    const flags = await prisma.flag.findMany({
      where: { workspaceId, projectId },
      select: { key: true, states: { where: { environmentId }, select: { enabled: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    res.json({
      environment: { id: environmentId, key: environmentKey },
      flags: flags.map((f) => ({ key: f.key, enabled: f.states[0]?.enabled ?? false })),
    });
  });

  return router;
}
