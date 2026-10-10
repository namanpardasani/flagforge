import { ACTIVITY, FLAGS, PROJECTS, WORKSPACES, type Activity, type Flag, type Project, type Workspace } from "./data";

/**
 * Stand-ins for the real API calls. Each one is async and waits a little, so the app goes through
 * genuine loading states. Prompt 2 replaces the bodies with `fetch` calls; the signatures stay.
 */
const LATENCY_MS = import.meta.env.MODE === "test" ? 0 : 420;
const respond = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));

export const fetchWorkspaces = (): Promise<Workspace[]> => respond([...WORKSPACES]);

export const fetchProjects = (workspaceSlug: string): Promise<Project[]> =>
  respond(PROJECTS.filter((p) => p.workspaceSlug === workspaceSlug));

export const fetchFlags = (projectKey: string): Promise<Flag[]> => respond(FLAGS.filter((f) => f.projectKey === projectKey));

export const fetchActivity = (projectKey: string): Promise<Activity[]> =>
  respond(ACTIVITY.filter((a) => a.projectKey === projectKey));
