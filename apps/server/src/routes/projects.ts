import { Router } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Config } from "../config.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validate } from "../middleware/validate.js";
import { requireWorkspaceRole } from "../middleware/workspace-access.js";
import {
  createEnvironmentSchema,
  createProjectSchema,
  environmentParams,
  projectParams,
} from "../projects/schemas.js";
import type { ProjectService } from "../projects/service.js";
import type { DashboardStreams } from "../realtime/dashboard-streams.js";
import { workspaceParams } from "../workspaces/schemas.js";

export function projectsRouter(service: ProjectService, prisma: PrismaClient, config: Config, live: DashboardStreams): Router {
  const router = Router();
  const auth = requireAuth(config);
  const viewer = requireWorkspaceRole(prisma, "VIEWER");
  const admin = requireWorkspaceRole(prisma, "ADMIN");
  const base = "/workspaces/:workspaceId/projects";

  router.get(base, auth, validate(workspaceParams, "params"), viewer, async (req, res) => {
    res.json({ projects: await service.listProjects(req.membership!.workspaceId) });
  });

  router.post(base, auth, validate(workspaceParams, "params"), admin, validate(createProjectSchema), async (req, res) => {
    res.status(201).json(await service.createProject(req.membership!.workspaceId, req.body));
  });

  router.get(`${base}/:projectId`, auth, validate(projectParams, "params"), viewer, async (req, res) => {
    res.json(await service.getProject(req.membership!.workspaceId, req.params["projectId"] as string));
  });

  router.delete(`${base}/:projectId`, auth, validate(projectParams, "params"), admin, async (req, res) => {
    await service.deleteProject(req.membership!.workspaceId, req.params["projectId"] as string);
    res.status(204).end();
  });

  router.get(`${base}/:projectId/environments`, auth, validate(projectParams, "params"), viewer, async (req, res) => {
    const environments = await service.listEnvironments(
      req.membership!.workspaceId,
      req.params["projectId"] as string,
    );
    res.json({ environments });
  });

  router.post(
    `${base}/:projectId/environments`,
    auth,
    validate(projectParams, "params"),
    admin,
    validate(createEnvironmentSchema),
    async (req, res) => {
      res
        .status(201)
        .json(
          await service.createEnvironment(req.membership!.workspaceId, req.params["projectId"] as string, req.body),
        );
    },
  );

  router.delete(
    `${base}/:projectId/environments/:environmentId`,
    auth,
    validate(environmentParams, "params"),
    admin,
    async (req, res) => {
      await service.deleteEnvironment(
        req.membership!.workspaceId,
        req.params["projectId"] as string,
        req.params["environmentId"] as string,
      );
      res.status(204).end();
    },
  );

  // Live updates for the dashboard. Any member may listen (it carries version numbers only); the
  // data itself is still fetched through the routes above, with their own role checks.
  router.get(`${base}/:projectId/stream`, auth, validate(projectParams, "params"), viewer, (req, res) =>
    live.handle(res, {
      userId: req.membership!.userId,
      workspaceId: req.membership!.workspaceId,
      projectId: req.params["projectId"] as string,
      expiresAt: req.tokenExpiresAt!,
    }),
  );

  return router;
}
