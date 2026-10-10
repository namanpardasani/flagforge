import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ApiKeyService } from "../apikeys/service.js";
import type { Config } from "../config.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validate } from "../middleware/validate.js";
import { requireWorkspaceRole } from "../middleware/workspace-access.js";

const id = z.string().min(1).max(64);
const envParams = z.object({ workspaceId: id, projectId: id, environmentId: id });
const keyParams = envParams.extend({ apiKeyId: id });
const createSchema = z.object({ name: z.string().trim().min(1).max(100) });

/** Managing keys is an ADMIN+ action: a key grants read access to a whole environment's flag config. */
export function apiKeysRouter(service: ApiKeyService, prisma: PrismaClient, config: Config): Router {
  const router = Router();
  const auth = requireAuth(config);
  const admin = requireWorkspaceRole(prisma, "ADMIN");
  const base = "/workspaces/:workspaceId/projects/:projectId/environments/:environmentId/api-keys";
  const p = (req: { params: Record<string, unknown> }, name: string) => req.params[name] as string;

  router.post(base, auth, validate(envParams, "params"), admin, validate(createSchema), async (req, res) => {
    const { workspaceId, userId } = req.membership!;
    res
      .status(201)
      .json(await service.create(workspaceId, p(req, "projectId"), p(req, "environmentId"), userId, req.body.name));
  });

  router.get(base, auth, validate(envParams, "params"), admin, async (req, res) => {
    const keys = await service.list(req.membership!.workspaceId, p(req, "projectId"), p(req, "environmentId"));
    res.json({ apiKeys: keys });
  });

  router.delete(`${base}/:apiKeyId`, auth, validate(keyParams, "params"), admin, async (req, res) => {
    const { workspaceId, userId } = req.membership!;
    await service.revoke(workspaceId, p(req, "projectId"), p(req, "environmentId"), userId, p(req, "apiKeyId"));
    res.status(204).end();
  });

  return router;
}
