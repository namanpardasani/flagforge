import { Navigate, useParams } from "react-router";
import { DEFAULT_SCOPE, paths } from "@/components/shell/use-scope";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { useProjects } from "@/data/queries";
import { NotFound } from "./ProjectPage";

/** "/w/:workspaceSlug" has no screen of its own: it forwards to that workspace's first project. */
export function WorkspaceIndex() {
  const { workspaceSlug = DEFAULT_SCOPE.workspaceSlug } = useParams();
  const projects = useProjects(workspaceSlug);

  if (projects.isPending) {
    return (
      <SkeletonGroup label="Opening workspace" className="flex h-dvh items-center justify-center bg-canvas">
        <Skeleton className="h-4 w-48" />
      </SkeletonGroup>
    );
  }
  const first = projects.data?.[0];
  return first ? <Navigate to={paths.project(workspaceSlug, first.key)} replace /> : <NotFound />;
}
