import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchActivity, fetchApiKeys, fetchFlags, fetchProjects, fetchWorkspaces } from "@/api/endpoints";
import { useSession } from "@/api/session";
import { can, type Project, type Role } from "@/api/types";
import { useLiveStatus } from "@/stores/live";

/**
 * Data hooks. Components call these and never know where the data comes from.
 *
 * TanStack Query in one line: you give it a key (a name for the data) and a function that fetches
 * it; it handles loading and error states, caches the result, and shares it between every
 * component that asks for the same key.
 *
 * Keys use server ids, so two projects with the same key in different workspaces never share data.
 */
export const queryKeys = {
  workspaces: ["workspaces"] as const,
  projects: (workspaceId: string) => ["projects", workspaceId] as const,
  flags: (projectId: string) => ["flags", projectId] as const,
  activity: (projectId: string) => ["activity", projectId] as const,
  apiKeys: (environmentId: string) => ["api-keys", environmentId] as const,
};

/** How often to refetch flags while the live stream is not delivering. */
const FALLBACK_POLL_MS = 15_000;

export function useWorkspaces() {
  const signedIn = useSession().status === "signedIn";
  return useQuery({ queryKey: queryKeys.workspaces, queryFn: fetchWorkspaces, enabled: signedIn });
}

export const useProjects = (workspaceId: string | undefined) =>
  useQuery({ queryKey: queryKeys.projects(workspaceId ?? "none"), queryFn: () => fetchProjects(workspaceId!), enabled: workspaceId !== undefined });

export function useFlags(project: Project | undefined) {
  const live = useLiveStatus();
  return useQuery({
    queryKey: queryKeys.flags(project?.id ?? "none"),
    queryFn: () => fetchFlags(project!),
    enabled: project !== undefined,
    refetchInterval: live === "live" ? false : FALLBACK_POLL_MS,
  });
}

/**
 * Recent changes to this project's flags, from the audit log. The server only lets admins read
 * it, so for anyone else the request is not even sent (and if it were, the 403 is shown kindly).
 */
export function useActivity(project: Project | undefined, role: Role | undefined) {
  const client = useQueryClient();
  return useQuery({
    queryKey: queryKeys.activity(project?.id ?? "none"),
    queryFn: async () => fetchActivity(project!, await client.ensureQueryData({ queryKey: queryKeys.flags(project!.id), queryFn: () => fetchFlags(project!) })),
    enabled: project !== undefined && can.readAuditLog(role),
  });
}

/** Keys of one environment. Admin-only on the server, so for other roles the request is not sent. */
export const useApiKeys = (project: Project | undefined, environmentId: string | undefined, role: Role | undefined) =>
  useQuery({
    queryKey: queryKeys.apiKeys(environmentId ?? "none"),
    queryFn: () => fetchApiKeys(project!, environmentId!),
    enabled: project !== undefined && environmentId !== undefined && can.manageKeys(role),
  });
