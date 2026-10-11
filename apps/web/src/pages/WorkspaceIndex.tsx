import { Link, Navigate, useParams } from "react-router";
import { RequireAuth } from "@/components/shell/RequireAuth";
import { paths, useScope } from "@/components/shell/use-scope";
import { EmptyState } from "@/components/ui/empty-state";
import { Problem } from "@/components/ui/problem";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";

/** "/w/:workspaceSlug" has no screen of its own: it forwards to that workspace's first project. */
export function WorkspaceIndex() {
  return (
    <RequireAuth>
      <Forward />
    </RequireAuth>
  );
}

function Forward() {
  const { workspaceSlug = "" } = useParams();
  const scope = useScope();

  if (scope.loading) {
    return (
      <SkeletonGroup label="Opening workspace" className="flex h-dvh items-center justify-center bg-canvas">
        <Skeleton className="h-4 w-48" />
      </SkeletonGroup>
    );
  }
  const first = scope.projects[0];
  if (first) return <Navigate to={paths.project(workspaceSlug, first.key)} replace />;

  return (
    <div className="mx-auto max-w-xl px-4 py-24">
      {scope.error ? (
        <Problem error={scope.error} what="this workspace" onRetry={scope.retry} />
      ) : (
        <EmptyState
          fig="4.04"
          title={scope.workspace ? `${scope.workspace.name} has no projects yet` : `No workspace called ${workspaceSlug}`}
          action={
            <Link to={paths.home} className="border-b border-ink pb-0.5 text-sm text-ink">
              Go to your workspace
            </Link>
          }
        >
          {scope.workspace ? "An owner or admin can create the first project." : "It does not exist, or you are not a member of it."}
        </EmptyState>
      )}
    </div>
  );
}
