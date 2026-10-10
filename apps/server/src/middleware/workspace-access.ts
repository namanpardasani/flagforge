import type { RequestHandler } from "express";
import type { PrismaClient, Role } from "../../generated/prisma/client.js";
import { AppError } from "../errors.js";
import { hasRole } from "../workspaces/roles.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireWorkspaceRole: the caller's role in the workspace named in the URL. */
      membership?: { workspaceId: string; userId: string; role: Role };
    }
  }
}

/**
 * Must run after requireAuth. Loads the caller's membership in :workspaceId and enforces a minimum role.
 * Non-members get 404 (not 403) so the existence of other tenants' workspaces is not revealed.
 */
export function requireWorkspaceRole(prisma: PrismaClient, min: Role): RequestHandler {
  return async (req, _res, next) => {
    const userId = req.userId;
    const workspaceId = req.params["workspaceId"];
    if (!userId) throw new AppError(401, "UNAUTHORIZED", "Missing bearer token");
    if (typeof workspaceId !== "string") throw new AppError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");

    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!member) throw new AppError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    if (!hasRole(member.role, min)) {
      throw new AppError(403, "FORBIDDEN", `This action requires the ${min} role or higher`);
    }
    req.membership = { workspaceId, userId, role: member.role };
    next();
  };
}
