import { auditSchema, flagSchema, flagsSchema, fromRule, projectSchema, projectsSchema, toActivity, toFlag, toProject, toWorkspace, workspaceSchema, workspacesSchema } from "./adapters";
import { request } from "./client";
import type { Activity, Flag, Project, Targeting, Workspace } from "./types";

/** One function per server route the dashboard uses. Each returns the app's own types. */

export const fetchWorkspaces = async (): Promise<Workspace[]> => (await request("GET", "/workspaces", { schema: workspacesSchema })).workspaces.map(toWorkspace);

export const createWorkspace = async (input: { name: string; slug: string }): Promise<Workspace> =>
  toWorkspace(await request("POST", "/workspaces", { body: input, schema: workspaceSchema }));

export const fetchProjects = async (workspaceId: string): Promise<Project[]> =>
  (await request("GET", `/workspaces/${workspaceId}/projects`, { schema: projectsSchema })).projects.map(toProject);

export const createProject = async (workspaceId: string, input: { name: string; key: string }): Promise<Project> =>
  toProject(await request("POST", `/workspaces/${workspaceId}/projects`, { body: input, schema: projectSchema }));

const flagsPath = (project: Project) => `/workspaces/${project.workspaceId}/projects/${project.id}/flags`;

export const fetchFlags = async (project: Project): Promise<Flag[]> => (await request("GET", flagsPath(project), { schema: flagsSchema })).flags.map(toFlag);

export const createFlag = async (project: Project, input: { key: string; name: string; description?: string }): Promise<Flag> =>
  toFlag(await request("POST", flagsPath(project), { body: input, schema: flagSchema }));

function environmentId(project: Project, env: string): string {
  const environment = project.environments.find((e) => e.key === env);
  if (!environment) throw new Error(`This project has no environment called ${env}`);
  return environment.id;
}

export const setFlagEnabled = async (project: Project, flagId: string, env: string, enabled: boolean): Promise<Flag> =>
  toFlag(await request("PUT", `${flagsPath(project)}/${flagId}/environments/${environmentId(project, env)}`, { body: { enabled }, schema: flagSchema }));

export const saveTargeting = async (project: Project, flagId: string, env: string, patch: Targeting): Promise<Flag> =>
  toFlag(
    await request("PUT", `${flagsPath(project)}/${flagId}/environments/${environmentId(project, env)}`, {
      body: { rolloutPercentage: patch.rolloutPercentage, rules: patch.rules.map(fromRule) },
      schema: flagSchema,
    }),
  );

/** The audit log is workspace-wide and admin-only on the server. Callers pass the project's flags to keep only its entries. */
export const fetchActivity = async (project: Project, flags: readonly Flag[]): Promise<Activity[]> =>
  toActivity((await request("GET", `/workspaces/${project.workspaceId}/audit-log?limit=100`, { schema: auditSchema })).entries, project, flags);
