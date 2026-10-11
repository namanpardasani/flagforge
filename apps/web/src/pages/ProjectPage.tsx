import { Link, useParams } from "react-router";
import { FigCaption } from "@/components/blueprint/marks";
import { ALL_NAV_ITEMS } from "@/components/shell/nav";
import { paths, useScope } from "@/components/shell/use-scope";
import { EmptyState } from "@/components/ui/empty-state";
import { ApiKeysPage } from "./ApiKeys";
import { EnvironmentsPage } from "./Environments";
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

  const item = ALL_NAV_ITEMS.find((i) => i.page === page);
  return item ? <NotBuiltYet label={item.label} /> : <NotFound />;
}

/** Screens that exist in the navigation but are built in a later step. Says so plainly. */
function NotBuiltYet({ label }: { label: string }) {
  return (
    <div className="space-y-8">
      <header>
        <FigCaption index="2.0" label={label} />
        <h1 className="mt-4 text-3xl font-medium leading-[1.15] tracking-tight text-ink">{label}</h1>
      </header>
      <EmptyState fig="2.1" title={`${label} is not wired up yet`}>
        The server already supports this. Its screen is built in a later step, so for now this page only shows that the shell, the navigation and this empty state work.
      </EmptyState>
    </div>
  );
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
