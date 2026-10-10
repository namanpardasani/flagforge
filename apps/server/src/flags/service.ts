import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../errors.js";
import type { CreateFlagInput, UpdateFlagInput } from "./schemas.js";

const flagNotFound = () => new AppError(404, "FLAG_NOT_FOUND", "Flag not found");
const projectNotFound = () => new AppError(404, "PROJECT_NOT_FOUND", "Project not found");

interface FlagRow {
  id: string;
  projectId: string;
  key: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  states: { environmentId: string; enabled: boolean }[];
}
interface EnvRow {
  id: string;
  key: string;
  name: string;
}

/** Every environment of the project appears in the result; a missing FlagState row means "off". */
function present(flag: FlagRow, environments: EnvRow[]) {
  const enabledBy = new Map(flag.states.map((s) => [s.environmentId, s.enabled]));
  return {
    id: flag.id,
    projectId: flag.projectId,
    key: flag.key,
    name: flag.name,
    description: flag.description,
    createdAt: flag.createdAt,
    updatedAt: flag.updatedAt,
    environments: environments.map((e) => ({
      environmentId: e.id,
      key: e.key,
      name: e.name,
      enabled: enabledBy.get(e.id) ?? false,
    })),
  };
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  entry: {
    workspaceId: string;
    actorId: string;
    action: string;
    entityId: string;
    metadata: Prisma.InputJsonValue;
  },
) {
  await tx.auditLog.create({ data: { ...entry, entityType: "flag" } });
}

/** All queries are filtered by workspaceId; a change and its audit entry share one transaction. */
export function createFlagService(prisma: PrismaClient) {
  async function requireProject(workspaceId: string, projectId: string) {
    const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } });
    if (!project) throw projectNotFound();
  }

  function projectEnvironments(workspaceId: string, projectId: string) {
    return prisma.environment.findMany({
      where: { projectId, workspaceId },
      select: { id: true, key: true, name: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async function loadFlag(workspaceId: string, projectId: string, flagId: string) {
    const flag = await prisma.flag.findFirst({
      where: { id: flagId, projectId, workspaceId },
      include: { states: { select: { environmentId: true, enabled: true } } },
    });
    if (!flag) throw flagNotFound();
    return present(flag, await projectEnvironments(workspaceId, projectId));
  }

  return {
    async createFlag(workspaceId: string, projectId: string, actorId: string, input: CreateFlagInput) {
      await requireProject(workspaceId, projectId);
      try {
        const flag = await prisma.$transaction(async (tx) => {
          const created = await tx.flag.create({
            data: { workspaceId, projectId, key: input.key, name: input.name, description: input.description ?? null },
          });
          await writeAudit(tx, {
            workspaceId,
            actorId,
            action: "flag.created",
            entityId: created.id,
            metadata: { key: created.key, projectId },
          });
          return created;
        });
        return loadFlag(workspaceId, projectId, flag.id);
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") {
          throw new AppError(409, "FLAG_KEY_TAKEN", "A flag with this key already exists in the project");
        }
        throw err;
      }
    },

    async listFlags(workspaceId: string, projectId: string) {
      await requireProject(workspaceId, projectId);
      const [flags, environments] = await Promise.all([
        prisma.flag.findMany({
          where: { projectId, workspaceId },
          include: { states: { select: { environmentId: true, enabled: true } } },
          orderBy: { createdAt: "asc" },
        }),
        projectEnvironments(workspaceId, projectId),
      ]);
      return flags.map((f) => present(f, environments));
    },

    getFlag: loadFlag,

    async updateFlag(workspaceId: string, projectId: string, flagId: string, actorId: string, input: UpdateFlagInput) {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.flag.findFirst({ where: { id: flagId, projectId, workspaceId } });
        if (!existing) throw flagNotFound();
        const data: { name?: string; description?: string | null } = {};
        if (input.name !== undefined) data.name = input.name;
        if (input.description !== undefined) data.description = input.description;
        await tx.flag.update({ where: { id: flagId }, data });
        await writeAudit(tx, {
          workspaceId,
          actorId,
          action: "flag.updated",
          entityId: flagId,
          metadata: { key: existing.key, changed: Object.keys(data) },
        });
      });
      return loadFlag(workspaceId, projectId, flagId);
    },

    async deleteFlag(workspaceId: string, projectId: string, flagId: string, actorId: string) {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.flag.findFirst({ where: { id: flagId, projectId, workspaceId } });
        if (!existing) throw flagNotFound();
        await tx.flag.delete({ where: { id: flagId } });
        await writeAudit(tx, {
          workspaceId,
          actorId,
          action: "flag.deleted",
          entityId: flagId,
          metadata: { key: existing.key, projectId },
        });
      });
    },

    /** Flag and environment must both belong to this project and workspace, or it is a 404. */
    async setFlagState(
      workspaceId: string,
      projectId: string,
      flagId: string,
      environmentId: string,
      actorId: string,
      enabled: boolean,
    ) {
      await prisma.$transaction(async (tx) => {
        const flag = await tx.flag.findFirst({ where: { id: flagId, projectId, workspaceId } });
        if (!flag) throw flagNotFound();
        const environment = await tx.environment.findFirst({ where: { id: environmentId, projectId, workspaceId } });
        if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");

        const current = await tx.flagState.findUnique({
          where: { flagId_environmentId: { flagId, environmentId } },
        });
        const from = current?.enabled ?? false;
        await tx.flagState.upsert({
          where: { flagId_environmentId: { flagId, environmentId } },
          create: { flagId, environmentId, workspaceId, enabled },
          update: { enabled },
        });
        if (from !== enabled) {
          await writeAudit(tx, {
            workspaceId,
            actorId,
            action: "flag.toggled",
            entityId: flagId,
            metadata: { key: flag.key, environmentId, environmentKey: environment.key, from, to: enabled },
          });
        }
      });
      return loadFlag(workspaceId, projectId, flagId);
    },

    listAuditLog(workspaceId: string, limit: number) {
      return prisma.auditLog.findMany({
        where: { workspaceId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        include: { actor: { select: { id: true, name: true, email: true } } },
      });
    },
  };
}

export type FlagService = ReturnType<typeof createFlagService>;
