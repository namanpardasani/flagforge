import { useQuery } from "@tanstack/react-query";
import { fetchActivity, fetchFlags, fetchProjects, fetchWorkspaces } from "@/mocks/api";

/**
 * Data hooks. Components call these and never know where the data comes from.
 *
 * TanStack Query in one line: you give it a key (a name for the data) and a function that fetches
 * it; it handles loading and error states, caches the result, and shares it between every
 * component that asks for the same key.
 */
export const queryKeys = {
  workspaces: ["workspaces"] as const,
  projects: (workspaceSlug: string) => ["projects", workspaceSlug] as const,
  flags: (projectKey: string) => ["flags", projectKey] as const,
  activity: (projectKey: string) => ["activity", projectKey] as const,
};

export const useWorkspaces = () => useQuery({ queryKey: queryKeys.workspaces, queryFn: fetchWorkspaces });

export const useProjects = (workspaceSlug: string) =>
  useQuery({ queryKey: queryKeys.projects(workspaceSlug), queryFn: () => fetchProjects(workspaceSlug) });

export const useFlags = (projectKey: string) => useQuery({ queryKey: queryKeys.flags(projectKey), queryFn: () => fetchFlags(projectKey) });

export const useActivity = (projectKey: string) =>
  useQuery({ queryKey: queryKeys.activity(projectKey), queryFn: () => fetchActivity(projectKey) });
