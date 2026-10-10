import { PanelLeft, Search } from "lucide-react";
import { useParams } from "react-router";
import { Breadcrumbs, type Crumb } from "@/components/ui/breadcrumbs";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { modKey } from "@/lib/platform";
import { pageLabel } from "./nav";
import { useShell } from "./use-shell";
import { paths, useScope } from "./use-scope";

interface TopBarProps {
  /** For pages outside a project (the UI kit), which supply their own trail. */
  crumbs?: readonly Crumb[];
}

export function TopBar({ crumbs }: TopBarProps) {
  const { collapsed, toggleCollapsed, env, setPaletteOpen } = useShell();
  const scope = useScope();
  const { page, flagKey } = useParams();

  const start: Crumb[] = [
    { label: scope.workspace?.name ?? scope.workspaceSlug, to: `/w/${scope.workspaceSlug}` },
    { label: scope.project?.name ?? scope.projectKey, to: paths.project(scope.workspaceSlug, scope.projectKey) },
  ];
  // On a flag's own page the trail goes one level deeper: ... / Flags / the-flag-key
  const trail: readonly Crumb[] =
    crumbs ??
    (flagKey
      ? [...start, { label: "Flags", to: paths.project(scope.workspaceSlug, scope.projectKey, "flags") }, { label: flagKey, current: true, mono: true }]
      : [...start, { label: pageLabel(page), current: true }]);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-3">
      <Button variant="ghost" size="icon" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={toggleCollapsed}>
        <PanelLeft strokeWidth={1.5} />
      </Button>
      <span aria-hidden className="h-4 w-px bg-hairline" />
      <Breadcrumbs items={trail} className="flex-1" />

      <span className="caption hidden text-faint sm:block">
        env <span className="text-muted">{env}</span>
      </span>
      <Button size="sm" aria-label="Open command palette" aria-keyshortcuts="Control+K Meta+K" onClick={() => setPaletteOpen(true)} className="gap-2 pl-2 pr-1.5 text-muted">
        <Search strokeWidth={1.5} />
        <span className="hidden sm:inline">Jump to</span>
        <span className="flex items-center gap-0.5">
          <Kbd>{modKey}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </Button>
    </header>
  );
}
