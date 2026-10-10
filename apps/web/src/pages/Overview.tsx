import { Frame } from "@/components/blueprint/Frame";
import { FigCaption, LiveDot } from "@/components/blueprint/marks";
import { useShell } from "@/components/shell/use-shell";
import { useScope } from "@/components/shell/use-scope";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActivity, useFlags } from "@/data/queries";
import { cn } from "@/lib/cn";
import { capitalize, countWord, formatStamp, plural } from "@/lib/format";
import { ENVIRONMENTS, type Flag, type FlagState } from "@/mocks/data";
import { RevealGroup, RevealItem } from "@/motion";

/** How one flag reads in one environment: "off", "on", or its rollout share. */
function stateText(state: FlagState) {
  if (!state.enabled) return "off";
  return state.rolloutPercentage < 100 ? `${state.rolloutPercentage}%` : "on";
}

export function OverviewPage() {
  const scope = useScope();
  const { env } = useShell();
  const flags = useFlags(scope.projectKey);
  const activity = useActivity(scope.projectKey);
  const envName = ENVIRONMENTS.find((e) => e.key === env)?.name.toLowerCase() ?? env;
  const projectName = scope.project?.name ?? scope.projectKey;

  if (flags.isPending || activity.isPending) return <OverviewSkeleton />;

  const all = flags.data ?? [];
  const live = all.filter((f) => f.states[env].enabled);
  const partial = live.filter((f) => f.states[env].rolloutPercentage < 100);
  const withRules = all.filter((f) => f.states[env].rules > 0);

  return (
    <RevealGroup className="space-y-10">
      <RevealItem>
        <FigCaption index="0.1" label="Overview" />
        {/* Two-tone headline: the fact in ink, the detail continuing in muted. One serif accent word. */}
        <h1 className="mt-4 max-w-3xl text-balance text-3xl font-medium leading-[1.15] tracking-tight text-ink">
          {all.length === 0 ? (
            <>
              {projectName} has <span className="accent text-[1.1em]">no</span> flags yet.
            </>
          ) : (
            <>
              {capitalize(countWord(all.length))} {plural(all.length, "flag")} in {projectName}, <span className="accent text-[1.1em]">{countWord(live.length)}</span> live in {envName}.{" "}
              <span className="text-muted">
                {capitalize(countWord(partial.length))} on a partial rollout, {countWord(withRules.length)} with targeting rules.
              </span>
            </>
          )}
        </h1>
      </RevealItem>

      <RevealItem>
        <Frame className="grid grid-cols-2 divide-hairline max-md:divide-y md:grid-cols-4 md:divide-x">
          <Stat label="Flags" value={all.length} note="in this project" />
          <Stat label={`On in ${env}`} value={live.length} note={`of ${all.length}`} live={live.length > 0} />
          <Stat label="Partial rollouts" value={partial.length} note="below 100%" />
          <Stat label="With rules" value={withRules.length} note={`targeting in ${env}`} />
        </Frame>
      </RevealItem>

      {all.length === 0 ? (
        <RevealItem>
          <EmptyState fig="0.2" title={`Nothing to report for ${projectName}`}>
            Once this project has flags, this page shows what is on in each environment and who changed it last.
          </EmptyState>
        </RevealItem>
      ) : (
        <RevealItem className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-labelledby="matrix-title">
            <FigCaption id="matrix-title" index="0.2" label="State by environment" />
            <Frame className="mt-3">
              <EnvironmentMatrix flags={all} />
            </Frame>
          </section>

          <section aria-labelledby="changes-title">
            <FigCaption id="changes-title" index="0.3" label="Recent changes" />
            <Frame className="mt-3">
              <ol>
                {(activity.data ?? []).slice(0, 6).map((entry) => (
                  <li key={entry.id} className="border-b border-hairline px-4 py-3 last:border-b-0">
                    <p className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-mono text-xs text-ink">{entry.subject}</span>
                      <time dateTime={entry.at} className="shrink-0 font-mono text-2xs text-faint">
                        {formatStamp(entry.at)}
                      </time>
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {entry.detail}
                      {entry.env && <span className="font-mono text-2xs text-faint"> / {entry.env}</span>}
                    </p>
                    <p className="mt-1 text-xs text-faint">{entry.actor}</p>
                  </li>
                ))}
              </ol>
            </Frame>
            <p className="caption mt-2 text-faint">Times in UTC</p>
          </section>
        </RevealItem>
      )}
    </RevealGroup>
  );
}

function Stat({ label, value, note, live = false }: { label: string; value: number; note: string; live?: boolean }) {
  return (
    <div className="px-5 py-4">
      <p className="caption flex items-center gap-2 text-muted">
        {live && <LiveDot />}
        {label}
      </p>
      <p className="mt-2 font-mono text-3xl leading-none text-ink">{String(value).padStart(2, "0")}</p>
      <p className="mt-2 text-xs text-faint">{note}</p>
    </div>
  );
}

function EnvironmentMatrix({ flags }: { flags: readonly Flag[] }) {
  const { env } = useShell();
  return (
    <Table aria-label="Flag state in each environment">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Flag</TableHead>
          {ENVIRONMENTS.map((e) => (
            <TableHead key={e.key} className={cn("w-24", e.key === env && "text-ink")}>
              {e.key}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {flags.map((flag) => (
          <TableRow key={flag.id}>
            <TableCell>
              <span className="block truncate font-mono text-xs text-ink">{flag.key}</span>
              <span className="block truncate text-xs text-muted">{flag.name}</span>
            </TableCell>
            {ENVIRONMENTS.map((e) => {
              const state = flag.states[e.key];
              return (
                <TableCell key={e.key} className="w-24">
                  <span className={cn("flex items-center gap-2 font-mono text-xs", !state.enabled ? "text-faint" : e.key === env ? "text-ink" : "text-muted")}>
                    <LiveDot on={state.enabled} emphasis={e.key === env} />
                    {stateText(state)}
                  </span>
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function OverviewSkeleton() {
  return (
    <SkeletonGroup label="Loading overview" className="space-y-10">
      <div>
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-5 h-8 w-[min(34rem,90%)]" />
        <Skeleton className="mt-2.5 h-8 w-[min(26rem,70%)]" />
      </div>
      <Skeleton className="h-[104px] w-full" />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    </SkeletonGroup>
  );
}
