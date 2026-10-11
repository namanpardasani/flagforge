import type { FlagConfig } from "@flagforge/core";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { parseStoredRules } from "../flags/targeting.js";

interface Scope {
  workspaceId: string;
  projectId: string;
  environmentId: string;
}

const select = (environmentId: string) =>
  ({
    key: true,
    states: { where: { environmentId }, select: { enabled: true, rules: true, fallthroughBps: true } },
  }) as const;

interface Row {
  key: string;
  states: { enabled: boolean; rules: unknown; fallthroughBps: number }[];
}

/** A flag with no state row for this environment is "off". */
function toConfig(row: Row): FlagConfig {
  const state = row.states[0];
  return {
    key: row.key,
    enabled: state?.enabled ?? false,
    rules: state ? parseStoredRules(state.rules) : [],
    fallthroughBps: state?.fallthroughBps ?? 10000,
  };
}

/** Every flag of the key's project, as seen by the key's environment. Always scoped by workspace. */
export async function loadFlagConfigs(prisma: PrismaClient, scope: Scope): Promise<FlagConfig[]> {
  const rows = await prisma.flag.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
    select: select(scope.environmentId),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toConfig);
}

