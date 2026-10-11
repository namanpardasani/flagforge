import type { Logger } from "pino";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { writeAudit } from "../audit.js";
import { AppError } from "../errors.js";
import type { FlagService } from "../flags/service.js";
import { setFlagStateSchema } from "../flags/targeting.js";
import { hasRole } from "../workspaces/roles.js";
import { MAX_LEAD_MS, MAX_PENDING_PER_TARGET, MIN_LEAD_MS, type CreateScheduledChangeInput } from "./schemas.js";

/** A claim older than this is assumed to belong to a process that died, and is taken over. */
const STALE_CLAIM_MINUTES = 5;

const select = {
  id: true,
  flagId: true,
  environmentId: true,
  runAt: true,
  patch: true,
  status: true,
  appliedAt: true,
  failure: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
  flag: { select: { key: true, name: true } },
  environment: { select: { key: true, name: true } },
} as const;

interface Claimed {
  id: string;
  workspaceId: string;
  flagId: string;
  environmentId: string;
  createdById: string | null;
  runAt: Date;
  patch: unknown;
}

/**
 * Changes planned for later: "at 09:00, take this flag to 25%". The runner applies each one
 * through the SAME code as a person pressing the button (FlagService.setFlagState), so the audit
 * log, the version bump and the live update to SDKs behave exactly as for a manual change.
 *
 * Every query is filtered by workspaceId.
 */
export function createScheduleService(prisma: PrismaClient, flags: FlagService, logger: Logger) {
  async function target(workspaceId: string, projectId: string, flagId: string, environmentId: string) {
    const flag = await prisma.flag.findFirst({ where: { id: flagId, projectId, workspaceId }, select: { id: true, key: true } });
    if (!flag) throw new AppError(404, "FLAG_NOT_FOUND", "Flag not found");
    const environment = await prisma.environment.findFirst({ where: { id: environmentId, projectId, workspaceId }, select: { id: true, key: true } });
    if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");
    return { flag, environment };
  }

  return {
    async create(workspaceId: string, projectId: string, flagId: string, environmentId: string, actorId: string, input: CreateScheduledChangeInput) {
      const { flag, environment } = await target(workspaceId, projectId, flagId, environmentId);
      const runAt = new Date(input.runAt);
      const lead = runAt.getTime() - Date.now();
      if (lead < MIN_LEAD_MS) throw new AppError(400, "RUN_AT_TOO_SOON", "Choose a time at least a minute from now. To change something right away, change it directly");
      if (lead > MAX_LEAD_MS) throw new AppError(400, "RUN_AT_TOO_FAR", "Choose a time within the next year");

      const waiting = await prisma.scheduledChange.count({ where: { workspaceId, flagId, environmentId, status: { in: ["PENDING", "RUNNING"] } } });
      if (waiting >= MAX_PENDING_PER_TARGET) throw new AppError(409, "TOO_MANY_SCHEDULED", `This flag already has ${MAX_PENDING_PER_TARGET} changes waiting in this environment. Cancel some first`);

      return prisma.$transaction(async (tx) => {
        const row = await tx.scheduledChange.create({
          data: { workspaceId, flagId, environmentId, createdById: actorId, runAt, patch: input.change as unknown as Prisma.InputJsonValue },
          select,
        });
        await writeAudit(tx, {
          workspaceId,
          actorId,
          action: "flag.schedule_created",
          entityType: "flag",
          entityId: flagId,
          metadata: { key: flag.key, projectId, environmentKey: environment.key, scheduledChangeId: row.id, runAt: runAt.toISOString(), change: input.change } as unknown as Prisma.InputJsonValue,
        });
        return row;
      });
    },

    /** "pending": waiting or running. "history": what already happened, newest first. */
    list(workspaceId: string, projectId: string, options: { status: "pending" | "history"; flagId?: string | undefined }) {
      const where = { workspaceId, flag: { projectId }, ...(options.flagId ? { flagId: options.flagId } : {}) };
      return options.status === "pending"
        ? prisma.scheduledChange.findMany({ where: { ...where, status: { in: ["PENDING", "RUNNING"] } }, select, orderBy: [{ runAt: "asc" }, { id: "asc" }], take: 200 })
        : prisma.scheduledChange.findMany({ where: { ...where, status: { in: ["APPLIED", "FAILED", "CANCELLED"] } }, select, orderBy: [{ runAt: "desc" }, { id: "desc" }], take: 50 });
    },

    async cancel(workspaceId: string, projectId: string, changeId: string, actorId: string) {
      const existing = await prisma.scheduledChange.findFirst({ where: { id: changeId, workspaceId, flag: { projectId } }, select: { id: true, flagId: true, status: true, runAt: true, flag: { select: { key: true } }, environment: { select: { key: true } } } });
      if (!existing) throw new AppError(404, "SCHEDULED_CHANGE_NOT_FOUND", "Scheduled change not found");
      await prisma.$transaction(async (tx) => {
        // Only a change that is still waiting can be cancelled. The condition is in the UPDATE, so
        // a change the runner has just claimed cannot also be cancelled.
        const { count } = await tx.scheduledChange.updateMany({ where: { id: changeId, workspaceId, status: "PENDING" }, data: { status: "CANCELLED" } });
        if (count === 0) throw new AppError(409, "NOT_PENDING", "This change has already run, was cancelled, or is running now");
        await writeAudit(tx, {
          workspaceId,
          actorId,
          action: "flag.schedule_cancelled",
          entityType: "flag",
          entityId: existing.flagId,
          metadata: { key: existing.flag.key, projectId, environmentKey: existing.environment.key, scheduledChangeId: changeId, runAt: existing.runAt.toISOString() },
        });
      });
    },

    /**
     * Applies every change that is due. Safe to call from several instances at once: rows are
     * claimed with FOR UPDATE SKIP LOCKED, so each is taken by exactly one runner. Uses the
     * DATABASE's clock, so instances with slightly different clocks agree on what "due" means.
     * Returns how many were applied and how many failed.
     */
    async runDue(limit = 20): Promise<{ applied: number; failed: number }> {
      const claimed = await prisma.$queryRaw<Claimed[]>`
        UPDATE "ScheduledChange" SET "status" = 'RUNNING', "claimedAt" = NOW()
        WHERE "id" IN (
          SELECT "id" FROM "ScheduledChange"
          WHERE ("status" = 'PENDING' AND "runAt" <= NOW())
             OR ("status" = 'RUNNING' AND "claimedAt" < NOW() - ${STALE_CLAIM_MINUTES} * INTERVAL '1 minute')
          ORDER BY "runAt" ASC, "id" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "id", "workspaceId", "flagId", "environmentId", "createdById", "runAt", "patch"`;
      // Ordered by runAt: two changes for the same flag land in the order they were planned.
      claimed.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());

      let applied = 0;
      let failed = 0;
      for (const change of claimed) {
        const failure = await apply(change);
        if (failure === null) applied++;
        else failed++;
      }
      return { applied, failed };
    },
  };

  /** Applies one claimed change. Returns null on success, or the reason it failed. */
  async function apply(change: Claimed): Promise<string | null> {
    let failure: string | null = null;
    let flagKey = "";
    let environmentKey = "";
    let projectId = "";
    try {
      const flag = await prisma.flag.findFirst({ where: { id: change.flagId, workspaceId: change.workspaceId }, select: { key: true, projectId: true } });
      const environment = await prisma.environment.findFirst({ where: { id: change.environmentId, workspaceId: change.workspaceId }, select: { key: true } });
      if (!flag || !environment) {
        failure = "The flag or the environment no longer exists";
      } else {
        flagKey = flag.key;
        environmentKey = environment.key;
        projectId = flag.projectId;
        // The person who planned this may have left, or lost the right to change flags, since.
        const member = change.createdById ? await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: change.workspaceId, userId: change.createdById } }, select: { role: true } }) : null;
        if (!change.createdById || !member) failure = "The person who scheduled this is no longer in the workspace";
        else if (!hasRole(member.role, "MEMBER")) failure = "The person who scheduled this can no longer change flags";
        else {
          // The stored patch is validated again: a row edited by hand must not bypass the rules.
          const patch = setFlagStateSchema.safeParse(change.patch);
          if (!patch.success) failure = "The stored change is no longer valid";
          else await flags.setFlagState(change.workspaceId, flag.projectId, change.flagId, change.environmentId, change.createdById, patch.data);
        }
      }
    } catch (err) {
      failure = err instanceof AppError ? err.message : "Unexpected error while applying the change";
      if (!(err instanceof AppError)) logger.error({ err: err instanceof Error ? err.message : "unknown", scheduledChangeId: change.id }, "scheduled change failed unexpectedly");
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Only a change still marked RUNNING is finished: if something else changed it meanwhile, leave it.
        const { count } = await tx.scheduledChange.updateMany({
          where: { id: change.id, status: "RUNNING" },
          data: failure === null ? { status: "APPLIED", appliedAt: new Date(), failure: null } : { status: "FAILED", failure: failure.slice(0, 300) },
        });
        if (count === 0 || !flagKey) return;
        await writeAudit(tx, {
          workspaceId: change.workspaceId,
          actorId: change.createdById,
          action: failure === null ? "flag.schedule_applied" : "flag.schedule_failed",
          entityType: "flag",
          entityId: change.flagId,
          metadata: { key: flagKey, projectId, environmentKey, scheduledChangeId: change.id, runAt: change.runAt.toISOString(), ...(failure ? { failure } : {}) } as Prisma.InputJsonValue,
        });
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : "unknown", scheduledChangeId: change.id }, "could not record the result of a scheduled change");
    }
    return failure;
  }
}

export type ScheduleService = ReturnType<typeof createScheduleService>;

/**
 * Runs due changes on a timer, inside the API process. Starts with an immediate pass, so changes
 * that fell due while the server was asleep or restarting are applied as soon as it is back.
 * One pass at a time: a slow pass is never overlapped by the next tick.
 */
export function startScheduler(service: Pick<ScheduleService, "runDue">, logger: Logger, intervalMs = 15_000) {
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const { applied, failed } = await service.runDue();
      if (applied + failed > 0) logger.info({ applied, failed }, "scheduled changes processed");
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : "unknown" }, "scheduler pass failed");
    } finally {
      running = false;
    }
  };
  void pass();
  const timer = setInterval(() => void pass(), intervalMs);
  timer.unref();
  return {
    /** Stops the timer and waits for a pass in progress to finish. */
    async stop() {
      clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}
