import { Link, useParams } from "react-router";
import { FigCaption } from "@/components/blueprint/marks";
import { paths, useScope } from "@/components/shell/use-scope";
import { ApiKeysPage } from "./ApiKeys";
import { AuditLogPage } from "./AuditLog";
import { EnvironmentsPage } from "./Environments";
import { ExperimentsPage } from "./Experiments";
import { FlagsPage } from "./Flags";
import { MembersPage } from "./Members";
import { OverviewPage } from "./Overview";

/** Picks the screen for "/w/:workspaceSlug/p/:projectKey/:page". */
export function ProjectPage() {
  const { page } = useParams();
  if (page === "overview") return <OverviewPage />;
  if (page === "flags") return <FlagsPage />;
  if (page === "api-keys") return <ApiKeysPage />;
  if (page === "members") return <MembersPage />;
  if (page === "environments") return <EnvironmentsPage />;
  if (page === "audit-log") return <AuditLogPage />;
  if (page === "experiments") return <ExperimentsPage />;

  return <NotFound />;
}

export function NotFound() {
  const scope = useScope();
  const home = scope.workspaceSlug && scope.projectKey ? paths.project(scope.workspaceSlug, scope.projectKey) : paths.home;
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="font-mono text-5xl text-ink">404</p>
      <FigCaption index="4.04" label="No such page" className="mt-6 justify-center" />
      <p className="mt-3 text-sm text-muted">That address does not match anything in FlagForge.</p>
      <Link to={home} className="mt-6 inline-block border-b border-ink pb-0.5 text-sm text-ink">
        Back to the overview
      </Link>
    </div>
  );
}
