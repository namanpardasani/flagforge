import type { Prisma } from "../../generated/prisma/client.js";
import { envTopic, publishQuietly, type EventBus } from "./bus.js";

export interface VersionBump {
  environmentId: string;
  version: number;
}

type Scope = { workspaceId: string } & ({ environmentId: string } | { projectId: string });

/**
 * Increments configVersion for one environment, or for every environment of a project (a new or
 * deleted flag changes all of them). Runs INSIDE the caller's transaction so the version and the
 * change commit together, and the increment is a single atomic UPDATE so concurrent changes never
 * produce the same number. Always filtered by workspaceId.
 */
export async function bumpEnvironments(tx: Prisma.TransactionClient, scope: Scope): Promise<VersionBump[]> {
  const rows =
    "environmentId" in scope
      ? await tx.$queryRaw<{ id: string; configVersion: number }[]>`
          UPDATE "Environment" SET "configVersion" = "configVersion" + 1
          WHERE "id" = ${scope.environmentId} AND "workspaceId" = ${scope.workspaceId}
          RETURNING "id", "configVersion"`
      : await tx.$queryRaw<{ id: string; configVersion: number }[]>`
          UPDATE "Environment" SET "configVersion" = "configVersion" + 1
          WHERE "projectId" = ${scope.projectId} AND "workspaceId" = ${scope.workspaceId}
          RETURNING "id", "configVersion"`;
  return rows.map((r) => ({ environmentId: r.id, version: r.configVersion }));
}

/** Call AFTER the transaction commits, so a listener that refetches immediately sees the new data. */
export async function announce(bus: EventBus, bumps: VersionBump[]): Promise<void> {
  await Promise.all(
    bumps.map((b) =>
      publishQuietly(bus, envTopic(b.environmentId), { type: "config", environmentId: b.environmentId, version: b.version }),
    ),
  );
}
