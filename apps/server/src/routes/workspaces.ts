import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Config } from "../config.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validate } from "../middleware/validate.js";
import { requireWorkspaceRole } from "../middleware/workspace-access.js";
import {
  addMemberSchema,
  createWorkspaceSchema,
  memberParams,
  updateMemberSchema,
  workspaceParams,
} from "../workspaces/schemas.js";
import type { WorkspaceService } from "../workspaces/service.js";

export function workspacesRouter(service: WorkspaceService, prisma: PrismaClient, config: Config): Router {
  const router = Router();
  const auth = requireAuth(config);
  const asViewer = [auth, validate(workspaceParams, "params"), requireWorkspaceRole(prisma, "VIEWER")];
  const asAdmin = [auth, validate(workspaceParams, "params"), requireWorkspaceRole(prisma, "ADMIN")];
  // Member routes allow any member through; the service decides (leaving yourself is always allowed).
  const memberRoute = [auth, validate(memberParams, "params"), requireWorkspaceRole(prisma, "VIEWER")];

  router.post("/workspaces", auth, validate(createWorkspaceSchema), async (req, res) => {
    res.status(201).json(await service.create(req.userId!, req.body));
  });

  router.get("/workspaces", auth, async (req, res) => {
    res.json({ workspaces: await service.listForUser(req.userId!) });
  });

  router.get("/workspaces/:workspaceId", ...asViewer, async (req, res) => {
    const { workspaceId, role } = req.membership!;
    res.json(await service.get(workspaceId, role));
  });

  router.get("/workspaces/:workspaceId/members", ...asViewer, async (req, res) => {
    res.json({ members: await service.listMembers(req.membership!.workspaceId) });
  });

  router.post("/workspaces/:workspaceId/members", ...asAdmin, validate(addMemberSchema), async (req, res) => {
    const { workspaceId, userId, role } = req.membership!;
    res.status(201).json(await service.addMember(workspaceId, { userId, role }, req.body));
  });

  router.patch(
    "/workspaces/:workspaceId/members/:userId",
    auth,
    validate(memberParams, "params"),
    requireWorkspaceRole(prisma, "ADMIN"),
    validate(updateMemberSchema),
    async (req, res) => {
      const { workspaceId, userId, role } = req.membership!;
      res.json(
        await service.updateMemberRole(workspaceId, { userId, role }, req.params["userId"] as string, req.body.role),
      );
    },
  );

  router.delete("/workspaces/:workspaceId/members/:userId", ...memberRoute, async (req, res) => {
    const { workspaceId, userId, role } = req.membership!;
    await service.removeMember(workspaceId, { userId, role }, req.params["userId"] as string);
    res.status(204).end();
  });

  return router;
}
