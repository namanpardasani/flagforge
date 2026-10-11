import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Config } from "../config.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validate } from "../middleware/validate.js";
import { requireWorkspaceRole } from "../middleware/workspace-access.js";
import { createScheduledChangeSchema, scheduledChangeParams, scheduledListParams, scheduledListQuery, scheduleTargetParams } from "../schedule/schemas.js";
import type { ScheduleService } from "../schedule/service.js";

/** Planning a change is as powerful as making it, so it needs the same role: MEMBER. Reading is open to any member. */
export function scheduleRouter(service: ScheduleService, prisma: PrismaClient, config: Config): Router {
  const router = Router();
  const auth = requireAuth(config);
  const viewer = requireWorkspaceRole(prisma, "VIEWER");
  const member = requireWorkspaceRole(prisma, "MEMBER");
  const project = "/workspaces/:workspaceId/projects/:projectId";
  const p = (req: { params: Record<string, unknown> }, name: string) => req.params[name] as string;

  router.post(`${project}/flags/:flagId/environments/:environmentId/schedule`, auth, validate(scheduleTargetParams, "params"), member, validate(createScheduledChangeSchema), async (req, res) => {
    const { workspaceId, userId } = req.membership!;
    res.status(201).json(await service.create(workspaceId, p(req, "projectId"), p(req, "flagId"), p(req, "environmentId"), userId, req.body));
  });

  router.get(`${project}/scheduled-changes`, auth, validate(scheduledListParams, "params"), viewer, validate(scheduledListQuery, "query"), async (req, res) => {
    const { status, flagId } = req.query as unknown as { status: "pending" | "history"; flagId?: string };
    res.json({ scheduledChanges: await service.list(req.membership!.workspaceId, p(req, "projectId"), { status, flagId }) });
  });

  router.delete(`${project}/scheduled-changes/:changeId`, auth, validate(scheduledChangeParams, "params"), member, async (req, res) => {
    const { workspaceId, userId } = req.membership!;
    await service.cancel(workspaceId, p(req, "projectId"), p(req, "changeId"), userId);
    res.status(204).end();
  });

  return router;
}
