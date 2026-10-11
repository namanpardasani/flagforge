import { useParams } from "react-router";
import { useProjects, useWorkspaces } from "@/data/queries";

/** Builds dashboard paths in one place, so the URL shape can change without a hunt through the code. */
export const paths = {
  /** Sends a signed-in user to their first project, and anyone else to sign in. */
  home: "/",
  login: "/login",
  register: "/register",
  welcome: "/welcome",
  project: (workspaceSlug: string, projectKey: string, page = "overview") => `/w/${workspaceSlug}/p/${projectKey}/${page}`,
  flag: (workspaceSlug: string, projectKey: string, flagKey: string) => `/w/${workspaceSlug}/p/${projectKey}/flags/${flagKey}`,
  experiment: (workspaceSlug: string, projectKey: string, experimentId: string) => `/w/${workspaceSlug}/p/${projectKey}/experiments/${experimentId}`,
  kit: "/kit",
  landing: "/landing",
};

/**
 * Which workspace and project the URL points at, plus the loaded records for them.
 * The URL is the source of truth: a copied link opens the same project. Pages outside a project
 * (the UI kit) have no such URL, so they fall back to the first workspace and its first project.
 *
 * `missing` says what the URL named that this user cannot see. The server answers 404 both for
 * "does not exist" and "exists but you are not a member", so the app cannot tell those apart either.
 */
export function useScope() {
  const params = useParams();
  const workspaces = useWorkspaces();
  const workspace = params["workspaceSlug"] ? workspaces.data?.find((w) => w.slug === params["workspaceSlug"]) : workspaces.data?.[0];

  const projects = useProjects(workspace?.id);
  const project = params["projectKey"] ? projects.data?.find((p) => p.key === params["projectKey"]) : projects.data?.[0];

  const loading = workspaces.isPending || (workspace !== undefined && projects.isPending);
  const error = workspaces.error ?? projects.error ?? null;
  const missing: "workspace" | "project" | undefined = loading || error ? undefined : !workspace ? "workspace" : !project ? "project" : undefined;

  return {
    workspaceSlug: params["workspaceSlug"] ?? workspace?.slug ?? "",
    projectKey: params["projectKey"] ?? project?.key ?? "",
    workspaces: workspaces.data ?? [],
    projects: projects.data ?? [],
    workspace,
    project,
    /** The signed-in user's role in this workspace. For showing or hiding controls only. */
    role: workspace?.role,
    loading,
    error,
    missing,
    retry: () => {
      void workspaces.refetch();
      if (workspace) void projects.refetch();
    },
  };
}
