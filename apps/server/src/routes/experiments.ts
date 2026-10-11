import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Config } from "../config.js";
import { createExperimentSchema, experimentParams, experimentsParams } from "../experiments/schemas.js";
import type { ExperimentService } from "../experiments/service.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validate } from "../middleware/validate.js";
import { requireWorkspaceRole } from "../middleware/workspace-access.js";

/**
 * Experiments, for the dashboard. Reading results: VIEWER and up. Creating, starting and stopping:
 * MEMBER and up (the same people who may change flags). Deleting, which destroys collected data:
 * ADMIN and up.
 */
export function experimentsRouter(service: ExperimentService, prisma: PrismaClient, config: Config): Router {
  const router = Router();
  const auth = requireAuth(config);
  const viewer = requireWorkspaceRole(prisma, "VIEWER");
  const member = requireWorkspaceRole(prisma, "MEMBER");
  const admin = requireWorkspaceRole(prisma, "ADMIN");
  const base = "/workspaces/:workspaceId/projects/:projectId/experiments";
  const p = (req: { params: Record<string, unknown> }, name: string) => req.params[name] as string;

  router.get(base, auth, validate(experimentsParams, "params"), viewer, async (req, res) => {
    res.json({ experiments: await service.list(req.membership!.workspaceId, p(req, "projectId")) });
  });

  router.post(base, auth, validate(experimentsParams, "params"), member, validate(createExperimentSchema), async (req, res) => {
    const { workspaceId, userId } = req.membership!;
    res.status(201).json(await service.create(workspaceId, p(req, "projectId"), userId, req.body));
  });

  router.get(`${base}/:experimentId`, auth, validate(experimentParams, "params"), viewer, async (req, res) => {
    res.json(await service.results(req.membership!.workspaceId, p(req, "projectId"), p(req, "experimentId")));
  });

  router.post(`${base}/:experimentId/start`, auth, validate(experimentParams, "params"), member, async (req, res) => {
    const { workspaceId, userId } = req.membership!;
    res.json(await service.start(workspaceId, p(req, "projectId"), p(req, "experimentId"), userId));
  });

  router.post(`${base}/:experimentId/stop`, auth, validate(experimentParams, "params"), member, async (req, res) => {
    const { workspaceId, userId } = req.membership!;
    res.json(await service.stop(workspaceId, p(req, "projectId"), p(req, "experimentId"), userId));
  });

  router.delete(`${base}/:experimentId`, auth, validate(experimentParams, "params"), admin, async (req, res) => {
    const { workspaceId, userId } = req.membership!;
    await service.remove(workspaceId, p(req, "projectId"), p(req, "experimentId"), userId);
    res.status(204).end();
  });

  return router;
}
