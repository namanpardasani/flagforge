import { apiKeysSchema, toAuditEntry, environmentSchema, memberSchema, membersSchema, toMember, auditSchema, createdApiKeySchema, toApiKey, flagSchema, flagsSchema, fromRule, projectSchema, projectsSchema, toActivity, toFlag, toProject, toWorkspace, workspaceSchema, workspacesSchema } from "./adapters";
import { request } from "./client";
import type { Activity, ApiKey, Flag, Member, Role, Project, Targeting, Workspace } from "./types";

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

const keysPath = (project: Project, environmentId: string) => `/workspaces/${project.workspaceId}/projects/${project.id}/environments/${environmentId}/api-keys`;

export const fetchApiKeys = async (project: Project, environmentId: string): Promise<ApiKey[]> =>
  (await request("GET", keysPath(project, environmentId), { schema: apiKeysSchema })).apiKeys.map(toApiKey);

/** Returns the new key AND its one-time secret. */
export const createApiKey = async (project: Project, environmentId: string, name: string): Promise<{ apiKey: ApiKey; secret: string }> => {
  const created = await request("POST", keysPath(project, environmentId), { body: { name }, schema: createdApiKeySchema });
  return { apiKey: toApiKey(created), secret: created.key };
};

export const revokeApiKey = (project: Project, environmentId: string, apiKeyId: string): Promise<void> =>
  request("DELETE", `${keysPath(project, environmentId)}/${apiKeyId}`);

export const fetchMembers = async (workspaceId: string): Promise<Member[]> => (await request("GET", `/workspaces/${workspaceId}/members`, { schema: membersSchema })).members.map(toMember);

export const addMember = async (workspaceId: string, input: { email: string; role: Role }): Promise<Member> =>
  toMember(await request("POST", `/workspaces/${workspaceId}/members`, { body: input, schema: memberSchema }));

export const changeMemberRole = async (workspaceId: string, userId: string, role: Role): Promise<Member> =>
  toMember(await request("PATCH", `/workspaces/${workspaceId}/members/${userId}`, { body: { role }, schema: memberSchema }));

export const removeMember = (workspaceId: string, userId: string): Promise<void> => request("DELETE", `/workspaces/${workspaceId}/members/${userId}`);

const environmentsPath = (project: Project) => `/workspaces/${project.workspaceId}/projects/${project.id}/environments`;

/** The server returns the new environment; the caller refetches the project list to pick it up. */
export const createEnvironment = async (project: Project, input: { name: string; key: string }): Promise<void> => {
  await request("POST", environmentsPath(project), { body: input, schema: environmentSchema });
};

export const deleteEnvironment = (project: Project, environmentId: string): Promise<void> => request("DELETE", `${environmentsPath(project)}/${environmentId}`);

/** One page of the workspace audit log, newest first. Pass the previous page's cursor to continue. */
export async function fetchAuditPage(workspaceId: string, before?: string): Promise<{ entries: Activity[]; nextCursor: string | null }> {
  const page = await request("GET", `/workspaces/${workspaceId}/audit-log?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`, { schema: auditSchema });
  return { entries: page.entries.map(toAuditEntry), nextCursor: page.nextCursor ?? null };
}
