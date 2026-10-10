import type { PrismaClient, Role } from "../../generated/prisma/client.js";
import { AppError } from "../errors.js";
import type { AddMemberInput, CreateWorkspaceInput } from "./schemas.js";

export interface Actor {
  userId: string;
  role: Role;
}

const memberSelect = {
  userId: true,
  role: true,
  joinedAt: true,
  user: { select: { email: true, name: true } },
} as const;

const forbidden = (message: string) => new AppError(403, "FORBIDDEN", message);

export function createWorkspaceService(prisma: PrismaClient) {
  /** The target must belong to THIS workspace, so ids from other tenants simply "don't exist". */
  async function findMember(workspaceId: string, userId: string) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: memberSelect,
    });
    if (!member) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found");
    return member;
  }

  return {
    async create(userId: string, input: CreateWorkspaceInput) {
      try {
        const workspace = await prisma.workspace.create({
          data: {
            name: input.name,
            slug: input.slug,
            ownerId: userId,
            members: { create: { userId, role: "OWNER" } }, // same transaction as the workspace
          },
        });
        return { ...workspace, role: "OWNER" as const };
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") {
          throw new AppError(409, "SLUG_TAKEN", "A workspace with this slug already exists");
        }
        throw err;
      }
    },

    async listForUser(userId: string) {
      const memberships = await prisma.workspaceMember.findMany({
        where: { userId },
        include: { workspace: true },
        orderBy: { joinedAt: "asc" },
      });
      return memberships.map((m) => ({ ...m.workspace, role: m.role }));
    },

    async get(workspaceId: string, role: Role) {
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
      if (!workspace) throw new AppError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
      return { ...workspace, role };
    },

    listMembers(workspaceId: string) {
      return prisma.workspaceMember.findMany({
        where: { workspaceId },
        select: memberSelect,
        orderBy: { joinedAt: "asc" },
      });
    },

    async addMember(workspaceId: string, actor: Actor, input: AddMemberInput) {
      if (input.role === "ADMIN" && actor.role !== "OWNER") {
        throw forbidden("Only the owner can add admins");
      }
      const user = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
      if (!user) throw new AppError(404, "USER_NOT_FOUND", "No user with this email");
      try {
        await prisma.workspaceMember.create({
          data: { workspaceId, userId: user.id, role: input.role },
        });
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") {
          throw new AppError(409, "ALREADY_MEMBER", "This user is already a member");
        }
        throw err;
      }
      return findMember(workspaceId, user.id);
    },

    async updateMemberRole(workspaceId: string, actor: Actor, targetUserId: string, role: Role) {
      if (targetUserId === actor.userId) throw forbidden("You cannot change your own role");
      const target = await findMember(workspaceId, targetUserId);
      if (target.role === "OWNER") throw forbidden("The owner's role cannot be changed");
      if ((target.role === "ADMIN" || role === "ADMIN") && actor.role !== "OWNER") {
        throw forbidden("Only the owner can grant or revoke admin");
      }
      await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        data: { role },
      });
      return findMember(workspaceId, targetUserId);
    },

    async removeMember(workspaceId: string, actor: Actor, targetUserId: string) {
      const target = await findMember(workspaceId, targetUserId);
      if (target.role === "OWNER") throw forbidden("The owner cannot be removed");
      const leaving = targetUserId === actor.userId;
      if (!leaving) {
        if (actor.role !== "OWNER" && actor.role !== "ADMIN") throw forbidden("Insufficient role");
        if (target.role === "ADMIN" && actor.role !== "OWNER") {
          throw forbidden("Only the owner can remove admins");
        }
      }
      await prisma.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
