import type { Rule } from "@flagforge/core";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { writeAudit } from "../audit.js";
import { announce, bumpEnvironments, type ChangeNotifier } from "../realtime/versions.js";
import { AppError } from "../errors.js";
import type { CreateFlagInput, UpdateFlagInput } from "./schemas.js";
import { normalizeRules, parseStoredRules, presentRule, toBps, toPercentage, type SetFlagStateInput } from "./targeting.js";

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
  states: { environmentId: string; enabled: boolean; rules: unknown; fallthroughBps: number; updatedAt: Date }[];
}
interface EnvRow {
  id: string;
  key: string;
  name: string;
}

const stateSelect = { environmentId: true, enabled: true, rules: true, fallthroughBps: true, updatedAt: true } as const;

/** Every environment of the project appears in the result; a missing FlagState row means "off, everyone". */
function present(flag: FlagRow, environments: EnvRow[]) {
  const stateBy = new Map(flag.states.map((s) => [s.environmentId, s]));
  return {
    id: flag.id,
    projectId: flag.projectId,
    key: flag.key,
    name: flag.name,
    description: flag.description,
    createdAt: flag.createdAt,
    updatedAt: flag.updatedAt,
    environments: environments.map((e) => {
      const state = stateBy.get(e.id);
      return {
        environmentId: e.id,
        key: e.key,
        name: e.name,
        enabled: state?.enabled ?? false,
        rules: state ? parseStoredRules(state.rules).map(presentRule) : [],
        rolloutPercentage: toPercentage(state?.fallthroughBps ?? 10000),
        // When this environment's state last changed; null if it was never touched (still the default).
        updatedAt: state?.updatedAt ?? null,
      };
    }),
  };
}

/** All queries are filtered by workspaceId; a change and its audit entry share one transaction. */
export function createFlagService(prisma: PrismaClient, notifier: ChangeNotifier) {
  async function requireProject(workspaceId: string, projectId: string) {
    const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } });
    if (!project) throw projectNotFound();
  }

  function projectEnvironments(workspaceId: string, projectId: string) {
    return prisma.environment.findMany({
      where: { projectId, workspaceId },
      select: { id: true, key: true, name: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async function loadFlag(workspaceId: string, projectId: string, flagId: string) {
    const flag = await prisma.flag.findFirst({
      where: { id: flagId, projectId, workspaceId },
      include: { states: { select: stateSelect } },
    });
    if (!flag) throw flagNotFound();
    return present(flag, await projectEnvironments(workspaceId, projectId));
  }

  return {
    async createFlag(workspaceId: string, projectId: string, actorId: string, input: CreateFlagInput) {
      await requireProject(workspaceId, projectId);
      try {
        const { flag, bumps } = await prisma.$transaction(async (tx) => {
          const created = await tx.flag.create({
            data: { workspaceId, projectId, key: input.key, name: input.name, description: input.description ?? null },
          });
          await writeAudit(tx, {
            workspaceId,
            actorId,
            entityType: "flag",
            action: "flag.created",
            entityId: created.id,
            metadata: { key: created.key, projectId },
          });
          // A new flag shows up (off) in every environment of the project, so all their versions move.
          return { flag: created, bumps: await bumpEnvironments(tx, { workspaceId, projectId }) };
        });
        await announce(notifier, bumps);
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
          include: { states: { select: stateSelect } },
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
          entityType: "flag",
          action: "flag.updated",
          entityId: flagId,
          metadata: { key: existing.key, changed: Object.keys(data) },
        });
      });
      return loadFlag(workspaceId, projectId, flagId);
    },

    async deleteFlag(workspaceId: string, projectId: string, flagId: string, actorId: string) {
      const bumps = await prisma.$transaction(async (tx) => {
        const existing = await tx.flag.findFirst({ where: { id: flagId, projectId, workspaceId } });
        if (!existing) throw flagNotFound();
        await tx.flag.delete({ where: { id: flagId } });
        await writeAudit(tx, {
          workspaceId,
          actorId,
          entityType: "flag",
          action: "flag.deleted",
          entityId: flagId,
          metadata: { key: existing.key, projectId },
        });
        return bumpEnvironments(tx, { workspaceId, projectId });
      });
      await announce(notifier, bumps);
    },

    /**
     * Updates a flag's state in ONE environment. Send only the fields to change (enabled, rules,
     * rolloutPercentage); the rest are kept. Flag and environment must both belong to this
     * project and workspace, or it is a 404.
     */
    async setFlagState(
      workspaceId: string,
      projectId: string,
      flagId: string,
      environmentId: string,
      actorId: string,
      patch: SetFlagStateInput,
    ) {
      const bumps = await prisma.$transaction(async (tx) => {
        const flag = await tx.flag.findFirst({ where: { id: flagId, projectId, workspaceId } });
        if (!flag) throw flagNotFound();
        const environment = await tx.environment.findFirst({ where: { id: environmentId, projectId, workspaceId } });
        if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");

        const current = await tx.flagState.findUnique({
          where: { flagId_environmentId: { flagId, environmentId } },
        });
        const before = {
          enabled: current?.enabled ?? false,
          rules: current ? parseStoredRules(current.rules) : ([] as Rule[]),
          fallthroughBps: current?.fallthroughBps ?? 10000,
        };
        const after = {
          enabled: patch.enabled ?? before.enabled,
          rules: patch.rules ? normalizeRules(patch.rules) : before.rules,
          fallthroughBps: patch.rolloutPercentage !== undefined ? toBps(patch.rolloutPercentage) : before.fallthroughBps,
        };

        const data = {
          enabled: after.enabled,
          rules: after.rules as unknown as Prisma.InputJsonValue,
          fallthroughBps: after.fallthroughBps,
        };
        await tx.flagState.upsert({
          where: { flagId_environmentId: { flagId, environmentId } },
          create: { flagId, environmentId, workspaceId, ...data },
          update: data,
        });

        const where = { key: flag.key, environmentId, environmentKey: environment.key };
        const targetingChanged =
          before.fallthroughBps !== after.fallthroughBps || JSON.stringify(before.rules) !== JSON.stringify(after.rules);
        if (before.enabled !== after.enabled) {
          await writeAudit(tx, {
            workspaceId,
            actorId,
            entityType: "flag",
            action: "flag.toggled",
            entityId: flagId,
            metadata: { ...where, from: before.enabled, to: after.enabled },
          });
        }
        if (targetingChanged) {
          await writeAudit(tx, {
            workspaceId,
            actorId,
            entityType: "flag",
            action: "flag.targeting_updated",
            entityId: flagId,
            metadata: {
              ...where,
              before: { rules: before.rules, fallthroughBps: before.fallthroughBps },
              after: { rules: after.rules, fallthroughBps: after.fallthroughBps },
            } as unknown as Prisma.InputJsonValue,
          });
        }
        // Only a real change moves the version, so a no-op save does not wake every connected SDK.
        const changed = before.enabled !== after.enabled || targetingChanged;
        return changed ? bumpEnvironments(tx, { workspaceId, environmentId }) : [];
      });
      await announce(notifier, bumps);
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
