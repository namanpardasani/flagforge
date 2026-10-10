import type { Prisma } from "../../generated/prisma/client.js";
import type { ConfigCache } from "../redis/config-cache.js";
import { envTopic, publishQuietly, type EventBus } from "./bus.js";

/** What a service needs to tell the rest of the system "this environment changed". */
export interface ChangeNotifier {
  bus: EventBus;
  cache: ConfigCache;
}

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

/**
 * Call AFTER the transaction commits. Order matters: first move the cache marker (so nothing
 * older than this version is served from cache anymore), THEN publish. An SDK that reacts to the
 * event and refetches immediately therefore can never be handed the stale cached copy.
 */
export async function announce({ bus, cache }: ChangeNotifier, bumps: VersionBump[]): Promise<void> {
  await Promise.all(
    bumps.map(async (b) => {
      await cache.markVersion(b.environmentId, b.version);
      await publishQuietly(bus, envTopic(b.environmentId), {
        type: "config",
        environmentId: b.environmentId,
        version: b.version,
      });
    }),
  );
}
