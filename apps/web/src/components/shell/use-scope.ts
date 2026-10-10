import { useParams } from "react-router";
import { useProjects, useWorkspaces } from "@/data/queries";

/** Builds dashboard paths in one place, so the URL shape can change without a hunt through the code. */
export const paths = {
  project: (workspaceSlug: string, projectKey: string, page = "overview") => `/w/${workspaceSlug}/p/${projectKey}/${page}`,
  kit: "/kit",
  landing: "/landing",
};

export const DEFAULT_SCOPE = { workspaceSlug: "halden", projectKey: "dispatch-api" };

/**
 * Which workspace and project the URL points at, plus the loaded records for them.
 * The URL is the source of truth: a copied link opens the same project.
 */
export function useScope() {
  const params = useParams();
  const workspaceSlug = params["workspaceSlug"] ?? DEFAULT_SCOPE.workspaceSlug;
  const projectKey = params["projectKey"] ?? DEFAULT_SCOPE.projectKey;

  const workspaces = useWorkspaces();
  const projects = useProjects(workspaceSlug);

  return {
    workspaceSlug,
    projectKey,
    workspaces: workspaces.data ?? [],
    projects: projects.data ?? [],
    workspace: workspaces.data?.find((w) => w.slug === workspaceSlug),
    project: projects.data?.find((p) => p.key === projectKey),
    loading: workspaces.isPending || projects.isPending,
  };
}
