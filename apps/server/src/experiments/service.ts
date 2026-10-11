import { createHash } from "node:crypto";
import { analyzeExperiment, type ExperimentAnalysis } from "@flagforge/core";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { writeAudit } from "../audit.js";
import { AppError } from "../errors.js";
import { parseStoredRules } from "../flags/targeting.js";
import type { CreateExperimentInput, SdkEvent } from "./schemas.js";

const notFound = () => new AppError(404, "EXPERIMENT_NOT_FOUND", "Experiment not found");

/**
 * The user key as stored. Hashed together with the experiment id, so:
 *  - the database never holds the application's real user identifiers, and
 *  - the same person has a different hash in every experiment (rows cannot be joined across them).
 * It only needs to be stable and collision-free, not secret, so plain SHA-256 is enough.
 */
export const hashUser = (experimentId: string, userKey: string) => createHash("sha256").update(`${experimentId}:${userKey}`).digest("hex").slice(0, 40);

interface Scope {
  workspaceId: string;
  environmentId: string;
}

const select = {
  id: true,
  projectId: true,
  environmentId: true,
  flagId: true,
  name: true,
  hypothesis: true,
  metricKey: true,
  status: true,
  startedAt: true,
  stoppedAt: true,
  createdAt: true,
  flag: { select: { key: true, name: true } },
  environment: { select: { key: true, name: true } },
} as const;

/** Every query is filtered by workspaceId; a change and its audit entry share one transaction. */
export function createExperimentService(prisma: PrismaClient) {
  const find = async (workspaceId: string, projectId: string, experimentId: string) => {
    const experiment = await prisma.experiment.findFirst({ where: { id: experimentId, projectId, workspaceId }, select });
    if (!experiment) throw notFound();
    return experiment;
  };

  /** Users and conversions per variant, straight from the database in one query. */
  async function counts(workspaceId: string, experimentId: string) {
    const rows = await prisma.$queryRaw<{ variant: boolean; users: bigint; conversions: bigint }[]>`
      SELECT e."variant", COUNT(*) AS users, COUNT(c."userHash") AS conversions
      FROM "ExperimentExposure" e
      LEFT JOIN "ExperimentConversion" c ON c."experimentId" = e."experimentId" AND c."userHash" = e."userHash"
      WHERE e."experimentId" = ${experimentId} AND e."workspaceId" = ${workspaceId}
      GROUP BY e."variant"`;
    const of = (variant: boolean) => {
      const row = rows.find((r) => r.variant === variant);
      return { users: Number(row?.users ?? 0), conversions: Number(row?.conversions ?? 0) };
    };
    return { control: of(false), treatment: of(true) };
  }

  /** What the flag currently does in the experiment's environment: needed to judge the split. */
  async function flagState(flagId: string, environmentId: string) {
    const state = await prisma.flagState.findUnique({ where: { flagId_environmentId: { flagId, environmentId } }, select: { enabled: true, fallthroughBps: true, rules: true } });
    return { enabled: state?.enabled ?? false, rolloutShare: (state?.fallthroughBps ?? 10000) / 10000, ruleCount: state ? parseStoredRules(state.rules).length : 0 };
  }

  return {
    async create(workspaceId: string, projectId: string, actorId: string, input: CreateExperimentInput) {
      // Both must belong to THIS project and workspace, or they "do not exist".
      const flag = await prisma.flag.findFirst({ where: { id: input.flagId, projectId, workspaceId }, select: { id: true, key: true } });
      if (!flag) throw new AppError(404, "FLAG_NOT_FOUND", "Flag not found");
      const environment = await prisma.environment.findFirst({ where: { id: input.environmentId, projectId, workspaceId }, select: { id: true, key: true } });
      if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");

      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.experiment.create({
          data: { workspaceId, projectId, environmentId: environment.id, flagId: flag.id, name: input.name, hypothesis: input.hypothesis ?? null, metricKey: input.metricKey },
          select,
        });
        await writeAudit(tx, { workspaceId, actorId, action: "experiment.created", entityType: "experiment", entityId: row.id, metadata: { name: row.name, key: flag.key, projectId, environmentKey: environment.key, metricKey: row.metricKey } });
        return row;
      });
      return created;
    },

    list(workspaceId: string, projectId: string) {
      return prisma.experiment.findMany({ where: { projectId, workspaceId }, select, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    },

    /** The experiment with its current numbers and what they mean. */
    async results(workspaceId: string, projectId: string, experimentId: string) {
      const experiment = await find(workspaceId, projectId, experimentId);
      const [groups, state] = await Promise.all([counts(workspaceId, experimentId), flagState(experiment.flagId, experiment.environmentId)]);

      // The share of users expected in treatment is only known when the rollout alone decides.
      // With targeting rules, who gets the flag depends on attributes the server never sees, so
      // the sample ratio check is skipped rather than reported against a made-up expectation.
      const splitKnown = state.ruleCount === 0 && state.rolloutShare > 0 && state.rolloutShare < 1;
      let analysis: ExperimentAnalysis | null = null;
      if (state.rolloutShare > 0 && state.rolloutShare < 1) {
        analysis = analyzeExperiment(groups.control, groups.treatment, { expectedTreatmentShare: state.rolloutShare });
      } else if (groups.control.users > 0 && groups.treatment.users > 0) {
        // The rollout is now 0% or 100%, but both groups have data from earlier: still compare them.
        analysis = analyzeExperiment(groups.control, groups.treatment, { expectedTreatmentShare: 0.5 });
      }
      return {
        ...experiment,
        flagState: { enabled: state.enabled, rolloutPercentage: state.rolloutShare * 100, ruleCount: state.ruleCount },
        groups,
        analysis: analysis && !splitKnown ? { ...analysis, sampleRatio: { ...analysis.sampleRatio, pValue: null, mismatch: false } } : analysis,
        sampleRatioChecked: analysis !== null && splitKnown,
      };
    },

    async start(workspaceId: string, projectId: string, experimentId: string, actorId: string) {
      const experiment = await find(workspaceId, projectId, experimentId);
      if (experiment.status === "RUNNING") throw new AppError(409, "ALREADY_RUNNING", "This experiment is already running");
      if (experiment.status === "STOPPED") throw new AppError(409, "EXPERIMENT_FINISHED", "A stopped experiment cannot be restarted: its data would mix two periods. Create a new one");

      // Refuse setups that cannot produce a comparison, with a reason someone can act on.
      const state = await flagState(experiment.flagId, experiment.environmentId);
      if (!state.enabled) throw new AppError(409, "FLAG_OFF", "Turn the flag on in this environment first: while it is off nobody is in the treatment group");
      if (state.ruleCount === 0 && (state.rolloutShare <= 0 || state.rolloutShare >= 1)) {
        throw new AppError(409, "NO_SPLIT", "Set the rollout between 1% and 99% first: an experiment needs some users with the flag and some without");
      }

      try {
        return await prisma.$transaction(async (tx) => {
          const row = await tx.experiment.update({ where: { id: experimentId }, data: { status: "RUNNING", startedAt: new Date() }, select });
          await writeAudit(tx, { workspaceId, actorId, action: "experiment.started", entityType: "experiment", entityId: experimentId, metadata: { name: row.name, key: row.flag.key, projectId, environmentKey: row.environment.key } });
          return row;
        });
      } catch (err) {
        // The partial unique index: another experiment on this flag and environment is running.
        if ((err as { code?: string }).code === "P2002") {
          throw new AppError(409, "ANOTHER_EXPERIMENT_RUNNING", "Another experiment is already running on this flag in this environment. Stop it first");
        }
        throw err;
      }
    },

    async stop(workspaceId: string, projectId: string, experimentId: string, actorId: string) {
      const experiment = await find(workspaceId, projectId, experimentId);
      if (experiment.status !== "RUNNING") throw new AppError(409, "NOT_RUNNING", "Only a running experiment can be stopped");
      return prisma.$transaction(async (tx) => {
        const row = await tx.experiment.update({ where: { id: experimentId }, data: { status: "STOPPED", stoppedAt: new Date() }, select });
        await writeAudit(tx, { workspaceId, actorId, action: "experiment.stopped", entityType: "experiment", entityId: experimentId, metadata: { name: row.name, key: row.flag.key, projectId, environmentKey: row.environment.key } });
        return row;
      });
    },

    async remove(workspaceId: string, projectId: string, experimentId: string, actorId: string) {
      const experiment = await find(workspaceId, projectId, experimentId);
      await prisma.$transaction(async (tx) => {
        await tx.experiment.delete({ where: { id: experimentId } });
        await writeAudit(tx, { workspaceId, actorId, action: "experiment.deleted", entityType: "experiment", entityId: experimentId, metadata: { name: experiment.name, key: experiment.flag.key, projectId, environmentKey: experiment.environment.key } });
      });
    },

    /**
     * Stores a batch of SDK events. Only RUNNING experiments in the API key's own environment are
     * touched; everything else in the batch is ignored (an SDK does not know which flags are under
     * experiment, so it reports all of them).
     *
     *  - exposure: the first variant a user is seen with is kept; later reports change nothing.
     *  - conversion: counted once per user, and only for users already exposed in that experiment
     *    (someone who never saw either variant tells us nothing about the flag).
     */
    async ingest(scope: Scope, events: SdkEvent[]): Promise<{ exposures: number; conversions: number }> {
      const running = await prisma.experiment.findMany({
        where: { workspaceId: scope.workspaceId, environmentId: scope.environmentId, status: "RUNNING" },
        select: { id: true, metricKey: true, flag: { select: { key: true } } },
      });
      if (running.length === 0) return { exposures: 0, conversions: 0 };

      const exposures = new Map<string, { experimentId: string; userHash: string; workspaceId: string; variant: boolean }>();
      const conversions = new Map<string, { experimentId: string; userHash: string; workspaceId: string }>();
      for (const event of events) {
        for (const experiment of running) {
          const userHash = hashUser(experiment.id, event.userKey);
          const key = `${experiment.id}:${userHash}`;
          if (event.type === "exposure" && event.flagKey === experiment.flag.key) {
            if (!exposures.has(key)) exposures.set(key, { experimentId: experiment.id, userHash, workspaceId: scope.workspaceId, variant: event.value }); // first in the batch wins
          } else if (event.type === "conversion" && event.metricKey === experiment.metricKey) {
            conversions.set(key, { experimentId: experiment.id, userHash, workspaceId: scope.workspaceId });
          }
        }
      }

      // skipDuplicates = "INSERT ... ON CONFLICT DO NOTHING": the first variant recorded for a user
      // stays, even when two requests race.
      const stored = exposures.size > 0 ? await prisma.experimentExposure.createMany({ data: [...exposures.values()], skipDuplicates: true }) : { count: 0 };

      let converted = 0;
      if (conversions.size > 0) {
        // Exposures are written first, so an exposure and a conversion in the same batch both count.
        const candidates = [...conversions.values()];
        const exposed = await prisma.experimentExposure.findMany({
          where: { workspaceId: scope.workspaceId, OR: candidates.map((c) => ({ experimentId: c.experimentId, userHash: c.userHash })) },
          select: { experimentId: true, userHash: true },
        });
        const known = new Set(exposed.map((e) => `${e.experimentId}:${e.userHash}`));
        const eligible = candidates.filter((c) => known.has(`${c.experimentId}:${c.userHash}`));
        if (eligible.length > 0) converted = (await prisma.experimentConversion.createMany({ data: eligible, skipDuplicates: true })).count;
      }
      return { exposures: stored.count, conversions: converted };
    },
  };
}

export type ExperimentService = ReturnType<typeof createExperimentService>;
