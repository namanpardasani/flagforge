import { ArrowLeft } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Frame } from "@/components/blueprint/Frame";
import { FigCaption, LiveDot } from "@/components/blueprint/marks";
import { FlagToggle } from "@/components/flags/FlagToggle";
import { RolloutPreview } from "@/components/flags/RolloutPreview";
import { ScheduledChanges } from "@/components/flags/ScheduledChanges";
import { RowFlash, UpdatedTag } from "@/components/flags/RowFlash";
import { RuleBuilder } from "@/components/flags/RuleBuilder";
import { useGuardedToggle } from "@/components/flags/use-flag-guard";
import { useShell } from "@/components/shell/use-shell";
import { paths, useScope } from "@/components/shell/use-scope";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { useSaveTargeting } from "@/data/mutations";
import { useActivity, useFlags } from "@/data/queries";
import { formatStamp, plural } from "@/lib/format";
import { sameTargeting, validateRule, type Targeting } from "@/lib/targeting";
import { can, envName, isProduction, stateOf, type Activity, type EnvKey, type Flag, type Project } from "@/api/types";
import { Problem } from "@/components/ui/problem";
import { quiet, RevealGroup, RevealItem } from "@/motion";

export function FlagDetailPage() {
  const { flagKey = "" } = useParams();
  const scope = useScope();
  const { env } = useShell();
  const flags = useFlags(scope.project);
  const activity = useActivity(scope.project, scope.role);
  const canEdit = can.editFlags(scope.role);
  const listPath = paths.project(scope.workspaceSlug, scope.projectKey, "flags");

  if (flags.isPending) return <DetailSkeleton />;
  if (flags.isError) return <Problem error={flags.error} what="this flag" onRetry={() => void flags.refetch()} />;

  const flag = flags.data?.find((f) => f.key === flagKey);
  if (!flag) {
    return (
      <EmptyState
        fig="1.3"
        title={`No flag called ${flagKey}`}
        action={
          <Link to={listPath} className="border-b border-ink pb-0.5 text-sm text-ink">
            Back to all flags
          </Link>
        }
      >
        It may have been deleted, or the address may belong to another project.
      </EmptyState>
    );
  }

  return (
    <RevealGroup className="space-y-10">
      <RevealItem>
        <Link to={listPath} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" strokeWidth={1.5} /> All flags
        </Link>
        <Header flag={flag} env={env} canEdit={canEdit} />
      </RevealItem>

      {/* The key resets the editor's draft when you switch flag or environment. */}
      <RevealItem className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <TargetingEditor key={`${flag.id}:${env}`} flag={flag} env={env} project={scope.project} canEdit={canEdit} />
        <aside className="space-y-10">
          <ScheduledChanges key={`${flag.id}:${env}`} flag={flag} env={env} project={scope.project} canEdit={canEdit} />
          <History entries={(activity.data ?? []).filter((a) => a.subject === flag.key)} loading={activity.isPending} allowed={can.readAuditLog(scope.role)} error={activity.error} />
        </aside>
      </RevealItem>
    </RevealGroup>
  );
}

function Header({ flag, env, canEdit }: { flag: Flag; env: EnvKey; canEdit: boolean }) {
  const toggle = useGuardedToggle();
  const state = stateOf(flag, env);
  return (
    <Frame className="relative mt-4 p-5">
      <RowFlash flagId={flag.id} />
      <div className="relative flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <FigCaption index="1.3" label="Flag" />
          <h1 className="mt-3 truncate font-mono text-2xl tracking-tight text-ink">{flag.key}</h1>
          <p className="mt-1 text-base text-ink">{flag.name}</p>
          <p className="mt-1 max-w-prose text-sm text-muted">{flag.description}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <p className="caption text-muted">{envName(env)}</p>
          <FlagToggle checked={state.enabled} onCheckedChange={(next) => toggle(flag, next)} label={`${flag.name} in ${envName(env)}`} disabled={!canEdit} showStatus />
          <UpdatedTag flagId={flag.id} />
          {env === "prod" && <p className="max-w-[14rem] text-right text-xs text-faint">Changes in Production need a hold to confirm.</p>}
        </div>
      </div>
    </Frame>
  );
}

/**
 * Rollout and rules for one environment.
 *
 * Edits go into a DRAFT, not straight to the server, because a slider fires dozens of values while
 * being dragged and rules are half-typed most of the time. "Apply" sends the draft; in Production
 * that button must be held.
 *
 * Three snapshots are involved:
 *   saved - what the server has (from the query cache; changes when someone else edits)
 *   base  - the saved value this draft started from
 *   draft - what is on screen
 */
function TargetingEditor({ flag, env, project, canEdit }: { flag: Flag; env: EnvKey; project: Project | undefined; canEdit: boolean }) {
  const state = stateOf(flag, env);
  const saved: Targeting = { rolloutPercentage: state.rolloutPercentage, rules: state.rules };
  const save = useSaveTargeting(project);

  const [base, setBase] = useState(saved);
  const [draft, setDraft] = useState(saved);
  const [stale, setStale] = useState(false);
  const [applied, setApplied] = useState(0);

  // The server's copy changed (our own save landed, or a live update arrived). Reconcile while
  // rendering, which React allows for state derived from props and avoids an extra effect pass.
  if (!sameTargeting(base, saved)) {
    setBase(saved);
    if (sameTargeting(draft, saved)) setStale(false); // it now matches what we have: nothing to do
    else if (sameTargeting(draft, base)) setDraft(saved); // we had no edits: follow the server
    else setStale(true); // we have edits AND the server moved: let the person decide
  }

  const dirty = !sameTargeting(draft, saved);
  const invalid = draft.rules.filter((r) => validateRule(r) !== null).length;

  const apply = () => {
    save.mutate({ flag, env, patch: draft });
    setStale(false);
    setApplied((n) => n + 1);
  };

  return (
    <div className="min-w-0 space-y-10">
      <section aria-labelledby="rollout-title">
        <FigCaption id="rollout-title" index="1.4" label="Rollout" />
        <Frame className="mt-3 p-5">
          <RolloutPreview flagKey={flag.key} value={draft.rolloutPercentage} saved={saved.rolloutPercentage} live={state.enabled} disabled={!canEdit} onChange={(rolloutPercentage) => setDraft((d) => ({ ...d, rolloutPercentage }))} />
        </Frame>
      </section>

      <section aria-labelledby="rules-title">
        <FigCaption id="rules-title" index="1.5" label="Targeting rules" />
        <p className="mt-2 max-w-prose text-sm text-muted">Checked from the top. The first rule a user matches decides, and the rest are skipped.</p>
        <div className="mt-3">
          <RuleBuilder rules={draft.rules} onChange={(rules) => setDraft((d) => ({ ...d, rules }))} disabled={!canEdit} />
          {!canEdit && <p className="mt-3 text-xs text-faint">Your role can read targeting but not change it.</p>}
        </div>
      </section>

      <section aria-labelledby="order-title">
        <FigCaption id="order-title" index="1.6" label="How a user is decided" />
        <ol className="mt-3 divide-y divide-hairline rounded-xs border border-hairline">
          <Step n="01" title="Kill switch" live={state.enabled}>
            {state.enabled ? `On in ${envName(env)}, so evaluation continues.` : `Off in ${envName(env)}: everyone gets "off" and nothing below is checked.`}
          </Step>
          <Step n="02" title="Rules">
            {draft.rules.length === 0 ? "None." : `${draft.rules.length} ${plural(draft.rules.length, "rule")}, first match wins.`}
          </Step>
          <Step n="03" title="Rollout">
            Everyone else: {draft.rolloutPercentage}% get the flag.
          </Step>
        </ol>
      </section>

      {/* Appears only when there is something to apply. A form control, so it only fades. */}
      <AnimatePresence>
        {dirty && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={quiet}
            role="region"
            aria-label="Unsaved changes"
            className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-xs border border-line-strong bg-raised px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">Unsaved changes for {envName(env)}</p>
              <p className="text-xs text-muted">
                {invalid > 0 ? `${invalid} ${plural(invalid, "rule")} ${invalid === 1 ? "needs" : "need"} fixing first.` : stale ? "This flag was also changed elsewhere. Applying overwrites that." : "Nothing is live until you apply."}
              </p>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(saved);
                setStale(false);
              }}
            >
              {stale ? "Load latest" : "Discard"}
            </Button>
            {isProduction(env) ? (
              // The key gives a fresh button after each apply, since a completed hold cannot be reused.
              <HoldToConfirm key={applied} tone="ink" disabled={invalid > 0} onConfirm={apply}>
                Hold to apply to {envName(env)}
              </HoldToConfirm>
            ) : (
              <Button variant="solid" disabled={invalid > 0} onClick={apply}>
                Apply to {envName(env)}
              </Button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Step({ n, title, live, children }: { n: string; title: string; live?: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[2.5rem_7rem_1fr] items-baseline gap-2 px-4 py-3">
      <span className="font-mono text-2xs text-faint">{n}</span>
      <span className="flex items-center gap-2 text-sm text-ink">
        {live !== undefined && <LiveDot on={live} />}
        {title}
      </span>
      <span className="text-sm text-muted">{children}</span>
    </li>
  );
}

function History({ entries, loading, allowed, error }: { entries: Activity[]; loading: boolean; allowed: boolean; error: unknown }) {
  return (
    <section aria-labelledby="history-title">
      <FigCaption id="history-title" index="1.7" label="Recent changes" />
      {!allowed ? (
        <p className="mt-3 rounded-xs border border-dashed border-hairline px-4 py-6 text-center text-sm text-muted">The change history is visible to workspace admins and owners.</p>
      ) : error ? (
        <p role="alert" className="mt-3 rounded-xs border border-dashed border-hairline px-4 py-6 text-center text-sm text-muted">
          The change history could not be loaded.
        </p>
      ) : loading ? (
        <SkeletonGroup label="Loading changes" className="mt-3 space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </SkeletonGroup>
      ) : entries.length === 0 ? (
        <p className="mt-3 rounded-xs border border-dashed border-hairline px-4 py-6 text-center text-sm text-muted">No changes recorded for this flag.</p>
      ) : (
        <Frame className="mt-3">
          <ol>
            <AnimatePresence initial={false} mode="popLayout">
              {entries.slice(0, 6).map((entry) => (
                <motion.li key={entry.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={quiet} className="border-b border-hairline px-4 py-3 last:border-b-0">
                  <p className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-ink">{entry.detail}</span>
                    <time dateTime={entry.at} className="shrink-0 font-mono text-2xs text-faint">
                      {formatStamp(entry.at)}
                    </time>
                  </p>
                  <p className="mt-1 text-xs text-faint">
                    {entry.actor}
                    {entry.env && <span className="font-mono text-2xs"> / {entry.env}</span>}
                  </p>
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        </Frame>
      )}
    </section>
  );
}

function DetailSkeleton() {
  return (
    <SkeletonGroup label="Loading flag" className="space-y-10">
      <div>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-4 h-[148px] w-full" />
      </div>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-10">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    </SkeletonGroup>
  );
}
