import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { Link, Navigate, useLocation, useOutlet } from "react-router";
import { Grain } from "@/components/blueprint/marks";
import { FlagGuard } from "@/components/flags/FlagGuard";
import type { Crumb } from "@/components/ui/breadcrumbs";
import { Toaster } from "@/components/ui/toaster";
import { EmptyState } from "@/components/ui/empty-state";
import { Problem } from "@/components/ui/problem";
import { useLiveUpdates } from "@/data/mutations";
import { page, spring } from "@/motion";
import { CommandPalette } from "./CommandPalette";
import { RequireAuth } from "./RequireAuth";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { paths, useScope } from "./use-scope";
import { useShell } from "./use-shell";

/**
 * The dashboard frame: sidebar, divider, top bar, and the page area.
 *
 * Three boxes move when the sidebar collapses (sidebar, divider, content). Each has Motion's
 * `layout` prop, so the browser lays them out at their final size immediately and Motion plays
 * the change as a transform. `layoutDependency={collapsed}` tells Motion to re-measure ONLY when
 * the sidebar toggles, instead of on every render.
 *
 * The divider is its own 1px element rather than a border on the sidebar: a border would be
 * stretched while its box is being scaled, but a box that only changes position stays crisp.
 *
 * Things every screen shares are mounted once here: the Production guard (FlagGuard), the toast
 * stack, the command palette, and the live stream that reports changes made by other people.
 */
export function AppShell({ crumbs }: { crumbs?: readonly Crumb[] }) {
  return (
    <RequireAuth>
      <ShellFrame crumbs={crumbs} />
    </RequireAuth>
  );
}

function ShellFrame({ crumbs }: { crumbs?: readonly Crumb[] }) {
  const { collapsed, env, setEnv } = useShell();
  const location = useLocation();
  // useOutlet returns the current child route as an element. AnimatePresence keeps the OLD
  // element mounted until its exit animation finishes, then shows the new one.
  const outlet = useOutlet();
  const scope = useScope();
  // Keeps this project's flags live: the server's stream says what changed, and rows flash.
  useLiveUpdates(scope.project, env);

  // The remembered environment may not exist in this project (projects can define their own).
  const environments = scope.project?.environments;
  useEffect(() => {
    if (!environments || environments.length === 0 || environments.some((e) => e.key === env)) return;
    setEnv((environments.find((e) => e.key === "prod") ?? environments[environments.length - 1]!).key);
  }, [environments, env, setEnv]);

  // A brand-new account has no workspace yet: there is nothing to frame.
  if (!scope.loading && !scope.error && scope.workspaces.length === 0) return <Navigate to={paths.welcome} replace />;

  let content = outlet;
  if (scope.error) content = <Problem error={scope.error} what="this workspace" onRetry={scope.retry} />;
  else if (scope.missing === "workspace") {
    content = (
      <EmptyState fig="4.04" title={`No workspace called ${scope.workspaceSlug}`} action={<Link to={paths.home} className="border-b border-ink pb-0.5 text-sm text-ink">Go to your workspace</Link>}>
        It does not exist, or you are not a member of it. Ask an owner to add you if you were expecting to see it.
      </EmptyState>
    );
  } else if (scope.missing === "project") {
    content = (
      <EmptyState fig="4.04" title={scope.projectKey ? `No project called ${scope.projectKey}` : `${scope.workspace?.name ?? "This workspace"} has no projects yet`} action={scope.projects[0] ? <Link to={paths.project(scope.workspaceSlug, scope.projects[0].key)} className="border-b border-ink pb-0.5 text-sm text-ink">Open {scope.projects[0].name}</Link> : undefined}>
        {scope.projectKey ? "It may have been deleted, or the address may be mistyped." : "An owner or admin can create the first project."}
      </EmptyState>
    );
  }

  return (
    <FlagGuard>
      <div className="flex h-dvh overflow-hidden bg-canvas">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-sm focus:border focus:border-ink focus:bg-raised focus:px-3 focus:py-1.5">
          Skip to content
        </a>

        <Sidebar />
        <motion.span aria-hidden layout layoutDependency={collapsed} transition={spring.layout} className="w-px shrink-0 bg-hairline" />

        <motion.div layout layoutDependency={collapsed} transition={spring.layout} className="min-w-0 flex-1">
          <motion.div layout="position" layoutDependency={collapsed} transition={spring.layout} className="relative flex h-dvh flex-col">
            <TopBar crumbs={crumbs} />
            <motion.main id="main" layoutScroll tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={location.pathname} variants={page} initial="hidden" animate="show" exit="exit" className="mx-auto w-full max-w-6xl px-6 py-8 lg:px-10">
                  {content}
                </motion.div>
              </AnimatePresence>
            </motion.main>
          </motion.div>
        </motion.div>

        <CommandPalette />
        <Toaster />
        <Grain />
      </div>
    </FlagGuard>
  );
}
