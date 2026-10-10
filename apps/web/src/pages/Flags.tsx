import { useState } from "react";
import { Frame } from "@/components/blueprint/Frame";
import { FigCaption, LiveDot } from "@/components/blueprint/marks";
import { useShell } from "@/components/shell/use-shell";
import { useScope } from "@/components/shell/use-scope";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { useFlags } from "@/data/queries";
import { formatStamp } from "@/lib/format";
import { ENVIRONMENTS, type Flag } from "@/mocks/data";
import { RevealGroup, RevealItem } from "@/motion";

type Filter = "all" | "on" | "off";

/**
 * Placeholder flag list for the shell review: it exercises tabs, skeletons, the switch and the
 * empty state. The real flag screens (create, rules, rollouts, saving) are built in Prompt 2.
 */
export function FlagsPage() {
  const scope = useScope();
  const { env } = useShell();
  const flags = useFlags(scope.projectKey);
  const [filter, setFilter] = useState<Filter>("all");
  // Local, unsaved overrides so the switches respond. Keyed by flag id + environment.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const envName = ENVIRONMENTS.find((e) => e.key === env)?.name ?? env;
  const projectName = scope.project?.name ?? scope.projectKey;
  const isOn = (flag: Flag) => overrides[`${flag.id}:${env}`] ?? flag.states[env].enabled;

  const all = flags.data ?? [];
  const onCount = all.filter(isOn).length;
  const tabs: TabItem[] = [
    { value: "all", label: "All", count: all.length },
    { value: "on", label: "On", count: onCount },
    { value: "off", label: "Off", count: all.length - onCount },
  ];
  const visible = all.filter((flag) => (filter === "all" ? true : filter === "on" ? isOn(flag) : !isOn(flag)));

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <FigCaption index="1.1" label="Flags" />
          <h1 className="mt-4 text-3xl font-medium leading-[1.15] tracking-tight text-ink">
            What is <span className="accent text-[1.1em]">switched</span> on in {envName.toLowerCase()}.
          </h1>
        </div>
        <p className="caption rounded-xs border border-hairline px-2 py-1 text-muted">Mock data / changes are not saved</p>
      </header>

      {flags.isPending ? (
        <FlagsSkeleton />
      ) : all.length === 0 ? (
        <EmptyState fig="1.2" title={`No flags in ${projectName} yet`}>
          A flag is a named switch your code checks before running a feature. Flags created for this project appear here, with one switch per environment.
        </EmptyState>
      ) : (
        <Tabs items={tabs} value={filter} onValueChange={(value) => setFilter(value as Filter)} label="Filter flags by state">
          <Frame className="mt-6">
            {visible.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted">
                No flags are {filter} in {envName.toLowerCase()}.
              </p>
            ) : (
              // The key restarts the stagger whenever the filter changes.
              <RevealGroup key={filter} step={0.03} role="list" aria-label="Flags">
                {visible.map((flag) => {
                  const on = isOn(flag);
                  const state = flag.states[env];
                  return (
                    <RevealItem key={flag.id} role="listitem" className="flex items-center gap-4 border-b border-hairline px-4 py-3 last:border-b-0">
                      <LiveDot on={on} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs text-ink">{flag.key}</p>
                        <p className="truncate text-sm text-muted">{flag.description}</p>
                      </div>
                      <span className="hidden w-16 text-right font-mono text-xs text-muted sm:block">{on ? `${state.rolloutPercentage}%` : "off"}</span>
                      <time dateTime={flag.updatedAt} className="hidden w-28 text-right font-mono text-2xs text-faint md:block">
                        {formatStamp(flag.updatedAt)}
                      </time>
                      <Switch
                        checked={on}
                        onCheckedChange={(checked) => setOverrides((current) => ({ ...current, [`${flag.id}:${env}`]: checked }))}
                        aria-label={`${flag.name} in ${envName}`}
                      />
                    </RevealItem>
                  );
                })}
              </RevealGroup>
            )}
          </Frame>
        </Tabs>
      )}
    </div>
  );
}

function FlagsSkeleton() {
  return (
    <SkeletonGroup label="Loading flags">
      <div className="flex gap-6 border-b border-hairline pb-2.5">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-12" />
      </div>
      <div className="mt-6 rounded-xs border border-hairline">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-hairline px-4 py-3 last:border-b-0">
            <Skeleton className="size-1.5" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
            <Skeleton className="h-[18px] w-8" />
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}
