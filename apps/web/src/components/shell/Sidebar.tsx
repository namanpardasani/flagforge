import { Blocks, Check, ChevronsUpDown, LogOut, PanelsTopLeft, type LucideIcon } from "lucide-react";
import { LayoutGroup, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { LiveDot } from "@/components/blueprint/marks";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { signOut, useSession } from "@/api/session";
import type { EnvKey } from "@/api/types";
import { spring } from "@/motion";
import { NAV_GROUPS } from "./nav";
import { useShell } from "./use-shell";
import { paths, useScope } from "./use-scope";

export const SIDEBAR_OPEN = 248;
export const SIDEBAR_RAIL = 56;

/** Three-letter codes for the rail, where there is no room for "staging". */
const ENV_SHORT: Record<EnvKey, string> = { dev: "dev", staging: "stg", prod: "prd" };
const shortEnv = (key: EnvKey) => ENV_SHORT[key] ?? key.slice(0, 3);

/** Fades with the sidebar: visible when open, gone (and unclickable) when collapsed to the rail. */
const whenOpen = "transition-opacity duration-150 ease-out-quart group-data-[collapsed=true]/sidebar:pointer-events-none group-data-[collapsed=true]/sidebar:opacity-0";

/**
 * The sidebar.
 *
 * How the collapse works without animating `width`: the <aside> changes width instantly in the
 * layout, and Motion's `layout` prop animates it there using a transform (it measures the box
 * before and after, then plays the difference as a scale: the FLIP technique). The content inside
 * always stays 248px wide and is simply clipped, with labels fading out, so nothing is ever
 * squashed. In the rail every icon lands at the same x position it had when open.
 */
export function Sidebar() {
  const { collapsed } = useShell();
  const scope = useScope();
  const params = useParams();
  // A flag key belongs to one project, so from a flag's page the project links go to the flag LIST.
  const page = params["page"] ?? (params["flagKey"] ? "flags" : "overview");
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <motion.aside
      layout
      layoutDependency={collapsed}
      transition={spring.layout}
      style={{ width: collapsed ? SIDEBAR_RAIL : SIDEBAR_OPEN }}
      data-collapsed={collapsed}
      aria-label="Sidebar"
      className="group/sidebar relative z-20 h-dvh shrink-0 overflow-hidden bg-canvas"
    >
      <motion.div
        layout="position"
        layoutDependency={collapsed}
        transition={spring.layout}
        style={{ width: SIDEBAR_OPEN }}
        className="flex h-full flex-col"
      >
        <WorkspaceSwitcher />

        <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2" onMouseLeave={() => setHovered(null)}>
          <LayoutGroup id="sidebar-nav">
            {NAV_GROUPS.map((group) => (
              <Section key={group.label} label={group.label}>
                {group.items.map((item) => (
                  <Row
                    key={item.page}
                    id={item.page}
                    to={paths.project(scope.workspaceSlug, scope.projectKey, item.page)}
                    label={item.label}
                    icon={item.icon}
                    hovered={hovered}
                    onHover={setHovered}
                    collapsed={collapsed}
                  />
                ))}
              </Section>
            ))}

            <Section label="Projects">
              {scope.projects.map((project) => {
                const active = project.key === scope.projectKey;
                return (
                  <Row
                    key={project.key}
                    id={`project:${project.key}`}
                    to={paths.project(scope.workspaceSlug, project.key, page)}
                    label={project.name}
                    forceActive={active}
                    hovered={hovered}
                    onHover={setHovered}
                    collapsed={collapsed}
                    leading={
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-4 items-center justify-center rounded-[1px] border font-mono text-[8px] uppercase leading-none tracking-tight",
                          active ? "border-ink text-ink" : "border-line-strong text-muted",
                        )}
                      >
                        {project.key.slice(0, 2)}
                      </span>
                    }
                  />
                );
              })}
            </Section>

            <Section label="Reference">
              <Row id="kit" to={paths.kit} label="UI kit" icon={Blocks} hovered={hovered} onHover={setHovered} collapsed={collapsed} />
              <Row id="landing" to={paths.landing} label="Landing preview" icon={PanelsTopLeft} hovered={hovered} onHover={setHovered} collapsed={collapsed} />
            </Section>
          </LayoutGroup>
        </nav>

        <EnvSwitcher />

        <UserMenu />
      </motion.div>
    </motion.aside>
  );
}

/** Who is signed in, and the way out. */
function UserMenu() {
  const session = useSession();
  const { collapsed } = useShell();
  const user = session.status === "signedIn" ? session.user : undefined;
  const initials = (user?.name ?? "")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <DropdownMenu>
      <Tooltip label={user?.name ?? "Account"} enabled={collapsed}>
        <DropdownMenuTrigger asChild>
          <button aria-label={`Account: ${user?.name ?? "loading"}`} className="flex h-14 w-full shrink-0 items-center gap-3 border-t border-hairline pl-[18px] pr-3 text-left outline-offset-[-2px] hover:bg-raised">
            <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-xs bg-ink font-mono text-[10px] font-medium text-canvas">
              {initials}
            </span>
            <span className={cn("min-w-0 leading-tight", whenOpen)}>
              <span className="block truncate text-sm text-ink">{user?.name ?? " "}</span>
              <span className="block truncate font-mono text-2xs text-muted">{user?.email ?? " "}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" className="w-[232px]">
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut strokeWidth={1.5} />
          <span className="flex-1">Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <p aria-hidden className={cn("caption px-5 pb-1 pt-5 text-faint", whenOpen)}>
        {label}
      </p>
      {children}
    </div>
  );
}

interface RowProps {
  id: string;
  to: string;
  label: string;
  icon?: LucideIcon;
  leading?: ReactNode;
  /** For rows whose "active" is not decided by the URL alone (the project list). */
  forceActive?: boolean;
  hovered: string | null;
  onHover: (id: string) => void;
  collapsed: boolean;
}

function Row({ id, to, label, icon: Icon, leading, forceActive, hovered, onHover, collapsed }: RowProps) {
  return (
    <Tooltip label={label} enabled={collapsed}>
      <NavLink
        to={to}
        aria-label={label}
        onMouseEnter={() => onHover(id)}
        onFocus={() => onHover(id)}
        className="relative flex h-8 items-center gap-3 pl-5 pr-3 text-sm outline-offset-[-2px]"
      >
        {({ isActive }) => {
          const active = forceActive ?? isActive;
          return (
            <>
              {/* Hover highlight: one element that slides between rows (idea from Watermelon UI's macos-sidebar). */}
              {hovered === id && <motion.span layoutId="nav-hover" transition={spring.snappy} className="absolute inset-y-0 left-2 right-2 rounded-xs bg-raised" />}
              {active && forceActive === undefined && <span aria-hidden className="absolute bottom-2 left-0 top-2 w-px bg-ember" />}
              <span className={cn("relative flex size-4 shrink-0 items-center justify-center", active ? "text-ink" : "text-muted")}>
                {Icon ? <Icon className="size-4" strokeWidth={1.5} /> : leading}
              </span>
              <span className={cn("relative truncate", active ? "text-ink" : "text-muted", whenOpen)}>{label}</span>
            </>
          );
        }}
      </NavLink>
    </Tooltip>
  );
}

function WorkspaceSwitcher() {
  const scope = useScope();
  const navigate = useNavigate();
  const { collapsed } = useShell();

  return (
    <DropdownMenu>
      <Tooltip label={scope.workspace?.name ?? "Workspace"} enabled={collapsed}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={`Workspace: ${scope.workspace?.name ?? "loading"}. Switch workspace`}
            className="flex h-12 w-full shrink-0 items-center gap-3 border-b border-hairline pl-[18px] pr-3 text-left outline-offset-[-2px] hover:bg-raised"
          >
            <Mark />
            <span className={cn("min-w-0 flex-1 leading-tight", whenOpen)}>
              <span className="block truncate text-sm font-medium text-ink">{scope.workspace?.name ?? " "}</span>
              <span className="block truncate font-mono text-2xs text-muted">{scope.workspace ? scope.workspace.role.toLowerCase() : " "}</span>
            </span>
            <ChevronsUpDown aria-hidden className={cn("size-3.5 shrink-0 text-faint", whenOpen)} />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" side="bottom" className="w-[232px]">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {scope.workspaces.map((workspace) => (
          <DropdownMenuItem key={workspace.slug} onSelect={() => navigate(`/w/${workspace.slug}`)}>
            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
            <span className="font-mono text-2xs text-faint">{workspace.slug}</span>
            {workspace.slug === scope.workspaceSlug ? <Check aria-label="Current" className="text-ink" /> : <span className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The FlagForge mark: a flag on a pole, with one ember square at the base. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={cn("size-5 shrink-0", className)}>
      <path d="M5 2.5v15M5 3.5h10l-2.75 3.25L15 10H5" stroke="currentColor" strokeWidth="1.25" className="text-ink" />
      <rect x="3.75" y="15.75" width="2.5" height="2.5" className="fill-ember" />
    </svg>
  );
}

function EnvSwitcher() {
  const { env, setEnv, collapsed } = useShell();
  const environments = useScope().project?.environments ?? [];
  const next = (current: EnvKey): EnvKey => environments[(environments.findIndex((e) => e.key === current) + 1) % Math.max(1, environments.length)]?.key ?? current;

  return (
    <div className="relative h-[68px] shrink-0 border-t border-hairline">
      {/* Open: one segment per environment. The raised marker is ONE element that slides to the chosen segment. */}
      <div inert={collapsed} className={cn("absolute inset-0 px-3 pt-2.5", whenOpen)}>
        <p id="env-label" className="caption px-2 pb-1.5 text-faint">
          Environment
        </p>
        <LayoutGroup id="env-switcher">
          <div role="group" aria-labelledby="env-label" style={{ gridTemplateColumns: `repeat(${Math.max(1, environments.length)}, minmax(0, 1fr))` }} className="grid rounded-sm border border-hairline bg-sunken p-0.5">
            {environments.map((environment) => {
              const active = environment.key === env;
              return (
                <button
                  key={environment.key}
                  type="button"
                  aria-pressed={active}
                  title={environment.name}
                  onClick={() => setEnv(environment.key)}
                  className={cn("relative flex h-6 items-center justify-center gap-1.5 rounded-xs font-mono text-2xs uppercase tracking-[0.06em]", active ? "text-ink" : "text-muted hover:text-ink")}
                >
                  {active && <motion.span layoutId="env-marker" transition={spring.layout} className="absolute inset-0 rounded-xs border border-line-strong bg-raised" />}
                  {active && <LiveDot className="relative" />}
                  <span className="relative truncate">{environment.key}</span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>
      </div>

      {/* Rail: only room for the current environment; pressing it steps to the next one. */}
      <div
        inert={!collapsed}
        className="pointer-events-none absolute left-0 top-0 flex h-full w-14 items-center justify-center opacity-0 transition-opacity duration-150 ease-out-quart group-data-[collapsed=true]/sidebar:pointer-events-auto group-data-[collapsed=true]/sidebar:opacity-100"
      >
        <Tooltip label={`Environment: ${env}. Press to switch`}>
          <button
            type="button"
            aria-label={`Environment: ${env}. Switch to ${next(env)}`}
            onClick={() => setEnv(next(env))}
            className="flex h-9 w-10 flex-col items-center justify-center gap-1 rounded-xs border border-hairline bg-sunken font-mono text-[9px] uppercase tracking-[0.06em] text-ink hover:border-line-strong"
          >
            <LiveDot />
            {shortEnv(env)}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
