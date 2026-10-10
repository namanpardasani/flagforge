import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Config } from "../config.js";
import {
  auditQuerySchema,
  createFlagSchema,
  flagParams,
  flagStateParams,
  flagsParams,
  setFlagStateSchema,
  updateFlagSchema,
} from "../flags/schemas.js";
import type { FlagService } from "../flags/service.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validate } from "../middleware/validate.js";
import { requireWorkspaceRole } from "../middleware/workspace-access.js";
import { workspaceParams } from "../workspaces/schemas.js";

export function flagsRouter(service: FlagService, prisma: PrismaClient, config: Config): Router {
  const router = Router();
  const auth = requireAuth(config);
  const viewer = requireWorkspaceRole(prisma, "VIEWER");
  const member = requireWorkspaceRole(prisma, "MEMBER");
  const admin = requireWorkspaceRole(prisma, "ADMIN");
  const base = "/workspaces/:workspaceId/projects/:projectId/flags";
  const param = (req: { params: Record<string, unknown> }, name: string) => req.params[name] as string;

  router.get(base, auth, validate(flagsParams, "params"), viewer, async (req, res) => {
    res.json({ flags: await service.listFlags(req.membership!.workspaceId, param(req, "projectId")) });
  });

  router.post(base, auth, validate(flagsParams, "params"), member, validate(createFlagSchema), async (req, res) => {
    const { workspaceId, userId } = req.membership!;
    res.status(201).json(await service.createFlag(workspaceId, param(req, "projectId"), userId, req.body));
  });

  router.get(`${base}/:flagId`, auth, validate(flagParams, "params"), viewer, async (req, res) => {
    res.json(await service.getFlag(req.membership!.workspaceId, param(req, "projectId"), param(req, "flagId")));
  });

  router.patch(
    `${base}/:flagId`,
    auth,
    validate(flagParams, "params"),
    member,
    validate(updateFlagSchema),
    async (req, res) => {
      const { workspaceId, userId } = req.membership!;
      res.json(
        await service.updateFlag(workspaceId, param(req, "projectId"), param(req, "flagId"), userId, req.body),
      );
    },
  );

  router.delete(`${base}/:flagId`, auth, validate(flagParams, "params"), admin, async (req, res) => {
    const { workspaceId, userId } = req.membership!;
    await service.deleteFlag(workspaceId, param(req, "projectId"), param(req, "flagId"), userId);
    res.status(204).end();
  });

  router.put(
    `${base}/:flagId/environments/:environmentId`,
    auth,
    validate(flagStateParams, "params"),
    member,
    validate(setFlagStateSchema),
    async (req, res) => {
      const { workspaceId, userId } = req.membership!;
      res.json(
        await service.setFlagState(
          workspaceId,
          param(req, "projectId"),
          param(req, "flagId"),
          param(req, "environmentId"),
          userId,
          req.body.enabled,
        ),
      );
    },
  );

  router.get(
    "/workspaces/:workspaceId/audit-log",
    auth,
    validate(workspaceParams, "params"),
    admin,
    validate(auditQuerySchema, "query"),
    async (req, res) => {
      const { limit } = req.query as unknown as { limit: number };
      res.json({ entries: await service.listAuditLog(req.membership!.workspaceId, limit) });
    },
  );

  return router;
}
