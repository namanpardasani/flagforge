import { ArrowUpRight, Copy, Plus, Power, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Frame } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { FlagToggle } from "@/components/flags/FlagToggle";
import { RowFlash, UpdatedTag } from "@/components/flags/RowFlash";
import { useGuardedToggle } from "@/components/flags/use-flag-guard";
import { useShell } from "@/components/shell/use-shell";
import { paths, useScope } from "@/components/shell/use-scope";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { useFlags } from "@/data/queries";
import { cn } from "@/lib/cn";
import { formatStamp, plural } from "@/lib/format";
import { can, envName, isProduction, stateOf, type EnvKey, type Flag } from "@/api/types";
import { NewFlagDialog } from "@/components/flags/NewFlagDialog";
import { Button } from "@/components/ui/button";
import { Problem } from "@/components/ui/problem";
import { duration, quiet } from "@/motion";
import { useFlash } from "@/stores/flash";
import { toast } from "@/stores/toasts";

type Filter = "all" | "on" | "off";
type Sort = "updated" | "key" | "state";

const SORTS: readonly { value: Sort; label: string }[] = [
  { value: "updated", label: "Updated" },
  { value: "key", label: "Key" },
  { value: "state", label: "State" },
];

// One column template shared by the header and every row, so they can never drift apart.
const columns = "grid grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-4 md:grid-cols-[96px_minmax(0,1fr)_64px_72px_128px_92px]";

export function FlagsPage() {
  const scope = useScope();
  const { env } = useShell();
  const flags = useFlags(scope.project);
  const canEdit = can.editFlags(scope.role);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("updated");
  const [query, setQuery] = useState("");

  const all = useMemo(() => flags.data ?? [], [flags.data]);
  const onCount = all.filter((f) => stateOf(f, env).enabled).length;
  const tabs: TabItem[] = [
    { value: "all", label: "All", count: all.length },
    { value: "on", label: "On", count: onCount },
    { value: "off", label: "Off", count: all.length - onCount },
  ];

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = all.filter((flag) => {
      const on = stateOf(flag, env).enabled;
      if (filter === "on" && !on) return false;
      if (filter === "off" && on) return false;
      return !needle || `${flag.key} ${flag.name} ${flag.description}`.toLowerCase().includes(needle);
    });
    return [...matches].sort((a, b) => {
      if (sort === "key") return a.key.localeCompare(b.key);
      if (sort === "state") return Number(stateOf(b, env).enabled) - Number(stateOf(a, env).enabled) || a.key.localeCompare(b.key);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [all, env, filter, query, sort]);

  // Rows stagger in once, when the list first arrives. Afterwards (filtering, sorting, live
  // updates) new rows must appear immediately, or the list would feel slower the more you use it.
  const hasRows = all.length > 0;
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!hasRows) return;
    const timer = setTimeout(() => setEntered(true), 500);
    return () => clearTimeout(timer);
  }, [hasRows]);

  const projectName = scope.project?.name ?? scope.projectKey;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <FigCaption index="1.1" label="Flags" />
          <h1 className="mt-4 text-3xl font-medium leading-[1.15] tracking-tight text-ink">
            What is <span className="accent text-[1.1em]">switched</span> on in {envName(env).toLowerCase()}.
          </h1>
        </div>
        {canEdit && scope.project && (
          <Button variant="solid" onClick={() => setCreating(true)}>
            <Plus strokeWidth={1.5} /> New flag
          </Button>
        )}
      </header>

      <NewFlagDialog project={scope.project} open={creating} onOpenChange={setCreating} />

      {flags.isPending ? (
        <FlagsSkeleton />
      ) : flags.isError ? (
        <Problem error={flags.error} what="the flags" onRetry={() => void flags.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState fig="1.2" title={`No flags in ${projectName} yet`} action={canEdit ? <Button onClick={() => setCreating(true)}>Create the first flag</Button> : undefined}>
          A flag is a named switch your code checks before running a feature. Flags created for this project appear here, with one switch per environment.
        </EmptyState>
      ) : (
        <Tabs items={tabs} value={filter} onValueChange={(value) => setFilter(value as Filter)} label="Filter flags by state">
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <label className="relative min-w-52 flex-1">
              <span className="sr-only">Search flags</span>
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" strokeWidth={1.5} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by key, name or description"
                className="h-8 w-full rounded-xs border border-hairline bg-sunken pl-8 pr-2 text-sm text-ink placeholder:text-faint hover:border-line-strong"
              />
            </label>
            <div role="group" aria-label="Sort flags" className="flex items-center gap-1">
              <span aria-hidden className="caption mr-1 text-faint">
                Sort
              </span>
              {SORTS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={sort === option.value}
                  onClick={() => setSort(option.value)}
                  className={cn("h-7 rounded-xs border px-2 text-xs", sort === option.value ? "border-line-strong bg-raised text-ink" : "border-transparent text-muted hover:text-ink")}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <Frame className="mt-4">
            <div aria-hidden className={cn(columns, "caption border-b border-hairline px-4 py-2 text-muted")}>
              <span>State</span>
              <span>Flag</span>
              <span className="hidden text-right md:block">Rollout</span>
              <span className="hidden md:block">Rules</span>
              <span className="hidden text-right md:block">Updated</span>
              <span />
            </div>
            {visible.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted">{query.trim() ? `Nothing matches "${query.trim()}".` : `No flags are ${filter} in ${envName(env).toLowerCase()}.`}</p>
            ) : (
              <ol aria-label="Flags">
                {/* popLayout: a row that leaves is lifted out at once, so the rows below can slide up
                    instead of waiting for it to finish fading. */}
                <AnimatePresence mode="popLayout" initial={false}>
                  {visible.map((flag, index) => (
                    <FlagRow key={flag.id} flag={flag} env={env} canEdit={canEdit} detailPath={paths.flag(scope.workspaceSlug, scope.projectKey, flag.key)} delay={entered ? 0 : index * 0.035} />
                  ))}
                </AnimatePresence>
              </ol>
            )}
          </Frame>
          <p aria-live="polite" className="caption mt-2 text-faint">
            {visible.length} of {all.length} {plural(all.length, "flag")} shown
          </p>
        </Tabs>
      )}
    </div>
  );
}

interface FlagRowProps {
  flag: Flag;
  env: EnvKey;
  /** Hides the switch's ability to act for read-only roles. The server refuses them anyway. */
  canEdit: boolean;
  detailPath: string;
  /** Entrance delay in seconds (the stagger). Zero after the first paint. */
  delay: number;
}

/**
 * One row. Wrapped in `memo`: when another row changes, this one is handed the same props and
 * React skips it entirely. It also subscribes to its own flash, so a live update re-renders
 * exactly one row.
 *
 * This table is a quiet zone: rows slide to a new position with a plain 180ms ease (`quiet`),
 * and the quick actions only fade.
 */
const FlagRow = memo(function FlagRow({ flag, env, canEdit, detailPath, delay }: FlagRowProps) {
  const toggle = useGuardedToggle();
  const flashing = useFlash(flag.id);
  const state = stateOf(flag, env);

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(flag.key);
      toast("Key copied", { detail: flag.key });
    } catch {
      toast("Could not copy", { detail: "The browser blocked clipboard access.", tone: "danger" });
    }
  };

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { ...quiet, delay } }}
      exit={{ opacity: 0, transition: { duration: duration.instant } }}
      transition={quiet}
      className={cn(columns, "group relative border-b border-hairline px-4 py-3 last:border-b-0 focus-within:bg-raised hover:bg-raised")}
    >
      <RowFlash flagId={flag.id} />
      <FlagToggle className="relative" checked={state.enabled} onCheckedChange={(next) => toggle(flag, next)} label={`${flag.name} in ${envName(env)}`} disabled={!canEdit} showStatus />

      <div className="relative min-w-0">
        <Link to={detailPath} className="block truncate font-mono text-xs text-ink underline-offset-4 hover:underline">
          {flag.key}
        </Link>
        <p className="truncate text-sm text-muted">{flag.description}</p>
      </div>

      <span className={cn("relative hidden text-right font-mono text-xs md:block", state.enabled ? "text-ink" : "text-faint")}>{state.rolloutPercentage}%</span>
      <span className="relative hidden font-mono text-xs text-muted md:block">{state.rules.length === 0 ? "none" : `${state.rules.length} ${plural(state.rules.length, "rule")}`}</span>
      <span className="relative hidden text-right md:block">
        {flashing?.kind === "remote" ? (
          <UpdatedTag flagId={flag.id} />
        ) : (
          <time dateTime={flag.updatedAt} className="font-mono text-2xs text-faint">
            {formatStamp(flag.updatedAt)}
          </time>
        )}
      </span>

      {/* Always in the page (so Tab reaches them); only their visibility changes on hover or focus. */}
      <span className="relative flex justify-end gap-0.5 opacity-0 transition-opacity duration-150 ease-out-quart group-focus-within:opacity-100 group-hover:opacity-100">
        {canEdit && isProduction(env) && state.enabled && (
          <QuickAction label={`Kill ${flag.key} in ${envName(env)}`} onClick={() => toggle(flag, false)} danger>
            <Power />
          </QuickAction>
        )}
        <QuickAction label={`Copy key ${flag.key}`} onClick={copyKey}>
          <Copy />
        </QuickAction>
        <Tooltip label="Open" side="top">
          <Link to={detailPath} aria-label={`Open ${flag.key}`} className="flex size-7 items-center justify-center rounded-xs text-muted hover:bg-canvas hover:text-ink [&_svg]:size-3.5 [&_svg]:stroke-[1.5]">
            <ArrowUpRight />
          </Link>
        </Tooltip>
      </span>
    </motion.li>
  );
});

function QuickAction({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn("flex size-7 items-center justify-center rounded-xs hover:bg-canvas [&_svg]:size-3.5 [&_svg]:stroke-[1.5]", danger ? "text-danger" : "text-muted hover:text-ink")}
      >
        {children}
      </button>
    </Tooltip>
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
      <Skeleton className="mt-5 h-8 w-full" />
      <div className="mt-4 rounded-xs border border-hairline">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-hairline px-4 py-3 last:border-b-0">
            <Skeleton className="h-5 w-9" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
            <Skeleton className="hidden h-3 w-24 md:block" />
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}
