import { Command } from "cmdk";
import { CornerDownLeft, Flag as FlagIcon, PanelLeft, Power, Search } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { Crosshairs } from "@/components/blueprint/Frame";
import { LiveDot } from "@/components/blueprint/marks";
import { Kbd } from "@/components/ui/kbd";
import { useGuardedToggle } from "@/components/flags/use-flag-guard";
import { useFlags } from "@/data/queries";
import { fuzzyScore } from "@/lib/fuzzy";
import { can, envName, isProduction, stateOf } from "@/api/types";
import { ALL_NAV_ITEMS } from "./nav";
import { useShell } from "./use-shell";
import { paths, useScope } from "./use-scope";

const groupClass =
  "px-1 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-faint";

function Item({ children, hint, ...props }: { children: ReactNode; hint?: ReactNode; value: string; keywords?: string[]; onSelect: () => void }) {
  return (
    <Command.Item
      className="flex h-9 cursor-pointer select-none items-center gap-3 rounded-xs px-2 text-sm text-muted data-[selected=true]:bg-canvas data-[selected=true]:text-ink [&_svg]:size-4 [&_svg]:shrink-0"
      {...props}
    >
      {children}
      {hint && <span className="ml-auto font-mono text-2xs text-faint">{hint}</span>}
    </Command.Item>
  );
}

/**
 * Ctrl/Cmd+K command palette: pages, projects, environments, every flag, and actions on them.
 *
 * Search is fuzzy (lib/fuzzy.ts): letters may be skipped, so "rtopt" finds "route-optimizer-v2"
 * and "kill pay" finds "Turn off instant-payouts". Each item also carries hidden keywords (the
 * flag's name, "kill", "disable"...) so it can be found by what people call it, not only by what
 * the row says. cmdk's own matcher was replaced because it let letters scatter across a whole
 * description, so a search for "audit" returned nine unrelated rows.
 *
 * Built from two accessible pieces rather than hand-rolled key handling:
 *  - Radix Dialog: focus trap, Escape to close, focus returns to where it was.
 *  - cmdk: the filterable list, arrow-key movement and `role="listbox"` semantics.
 * Watermelon UI's "command-search" was reviewed for this but has no ARIA roles, so only its
 * quick fade-and-scale entrance was kept.
 */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, toggleCollapsed, collapsed, env, setEnv } = useShell();
  const scope = useScope();
  const navigate = useNavigate();
  const params = useParams();
  const page = params["page"] ?? (params["flagKey"] ? "flags" : params["experimentId"] ? "experiments" : "overview");
  const flags = useFlags(scope.project).data ?? [];
  const environments = scope.project?.environments ?? [];
  const canEdit = can.editFlags(scope.role);
  const toggle = useGuardedToggle();

  /** Close first, then act, so focus is not stolen back by the closing dialog. */
  const run = (action: () => void) => () => {
    setPaletteOpen(false);
    action();
  };

  return (
    <Dialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-canvas/80 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-150" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[16vh] z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 rounded-xs border border-hairline bg-raised outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=open]:duration-150"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Crosshairs />
          <Command label="Command palette" loop filter={(value, search, keywords) => fuzzyScore([value, ...(keywords ?? [])].join(" "), search)}>
            <div className="flex h-12 items-center gap-3 border-b border-hairline px-4">
              <Search aria-hidden className="size-4 shrink-0 text-muted" strokeWidth={1.5} />
              <Command.Input placeholder="Search flags, pages and actions" className="h-full flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint" />
              <Kbd>esc</Kbd>
            </div>

            <Command.List className="max-h-[min(360px,50vh)] overflow-y-auto pb-1">
              <Command.Empty className="px-4 py-8 text-center text-sm text-muted">Nothing matches that.</Command.Empty>

              <Command.Group heading="Go to" className={groupClass}>
                {ALL_NAV_ITEMS.map((item) => (
                  <Item key={item.page} value={`go ${item.label}`} onSelect={run(() => navigate(paths.project(scope.workspaceSlug, scope.projectKey, item.page)))}>
                    <item.icon strokeWidth={1.5} />
                    {item.label}
                  </Item>
                ))}
              </Command.Group>

              {flags.length > 0 && (
                <Command.Group heading="Flags" className={groupClass}>
                  {flags.map((flag) => (
                    <Item
                      key={flag.id}
                      value={`flag ${flag.key}`}
                      keywords={[flag.name, flag.description]}
                      hint={stateOf(flag, env).enabled ? `on in ${env}` : `off in ${env}`}
                      onSelect={run(() => navigate(paths.flag(scope.workspaceSlug, scope.projectKey, flag.key)))}
                    >
                      <FlagIcon strokeWidth={1.5} />
                      <span className="truncate font-mono text-xs">{flag.key}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}

              {flags.length > 0 && canEdit && (
                <Command.Group heading="Actions" className={groupClass}>
                  {flags.map((flag) => {
                    const on = stateOf(flag, env).enabled;
                    return (
                      <Item
                        key={flag.id}
                        value={`turn ${on ? "off" : "on"} ${flag.key}`}
                        keywords={[flag.name, envName(env), on ? "kill disable stop" : "enable start launch"]}
                        hint={isProduction(env) ? "hold to confirm" : env}
                        // In Production this opens the hold-to-confirm dialog rather than acting at once.
                        onSelect={run(() => toggle(flag, !on))}
                      >
                        <Power strokeWidth={1.5} />
                        <span className="truncate">
                          Turn {on ? "off" : "on"} <span className="font-mono text-xs">{flag.key}</span>
                        </span>
                      </Item>
                    );
                  })}
                </Command.Group>
              )}

              <Command.Group heading="Switch project" className={groupClass}>
                {scope.projects.map((project) => (
                  <Item
                    key={project.key}
                    value={`project ${project.name} ${project.key}`}
                    hint={project.key}
                    onSelect={run(() => navigate(paths.project(scope.workspaceSlug, project.key, page)))}
                  >
                    <span aria-hidden className="flex size-4 items-center justify-center rounded-[1px] border border-line-strong font-mono text-[8px] uppercase leading-none tracking-tight">
                      {project.key.slice(0, 2)}
                    </span>
                    {project.name}
                  </Item>
                ))}
              </Command.Group>

              <Command.Group heading="Environment" className={groupClass}>
                {environments.map((environment) => (
                  <Item
                    key={environment.key}
                    value={`environment ${environment.name} ${environment.key}`}
                    hint={environment.key === env ? "current" : undefined}
                    onSelect={run(() => setEnv(environment.key))}
                  >
                    <span className="flex size-4 items-center justify-center">
                      <LiveDot on={environment.key === env} />
                    </span>
                    {environment.name}
                  </Item>
                ))}
              </Command.Group>

              <Command.Group heading="View" className={groupClass}>
                <Item value="view toggle sidebar collapse expand" onSelect={run(toggleCollapsed)}>
                  <PanelLeft strokeWidth={1.5} />
                  {collapsed ? "Expand sidebar" : "Collapse sidebar"}
                </Item>
              </Command.Group>
            </Command.List>

            <div className="flex h-9 items-center gap-4 border-t border-hairline px-4 font-mono text-2xs text-faint">
              <span className="flex items-center gap-1.5">
                <Kbd>&uarr;</Kbd>
                <Kbd>&darr;</Kbd> move
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>
                  <CornerDownLeft className="size-2.5" />
                </Kbd>
                open
              </span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
