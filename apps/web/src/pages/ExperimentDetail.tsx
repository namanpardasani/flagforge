import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { can, type ExperimentResults } from "@/api/types";
import { ApiError } from "@/api/client";
import { Frame } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { paths, useScope } from "@/components/shell/use-scope";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Problem } from "@/components/ui/problem";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Ticker } from "@/components/ui/ticker";
import { useExperimentMutations } from "@/data/mutations";
import { useExperimentResults } from "@/data/queries";
import { cn } from "@/lib/cn";
import { describeResult, MIN_USERS_PER_GROUP, percent, splitProblem } from "@/lib/experiments";
import { formatStamp } from "@/lib/format";
import { StatusMark } from "./StatusMark";

export function ExperimentDetailPage() {
  const { experimentId = "" } = useParams();
  const scope = useScope();
  const navigate = useNavigate();
  const query = useExperimentResults(scope.project, experimentId);
  const { start, stop, remove } = useExperimentMutations(scope.project);
  const [confirming, setConfirming] = useState<"stop" | "delete" | null>(null);
  const listPath = paths.project(scope.workspaceSlug, scope.projectKey, "experiments");

  if (query.isPending) {
    return (
      <SkeletonGroup label="Loading the experiment" className="space-y-6">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-40 w-full" />
      </SkeletonGroup>
    );
  }
  if (query.error instanceof ApiError && query.error.isNotFound) {
    return (
      <EmptyState fig="3.11" title="No such experiment" action={<Link to={listPath} className="border-b border-ink pb-0.5 text-sm text-ink">Back to experiments</Link>}>
        It may have been deleted, or the address may belong to another project.
      </EmptyState>
    );
  }
  if (query.isError) return <Problem error={query.error} what="this experiment" onRetry={() => void query.refetch()} />;

  const results = query.data;
  const { experiment } = results;
  const canRun = can.runExperiments(scope.role);
  const canDelete = can.deleteExperiments(scope.role);
  const text = describeResult(results);
  const problem = splitProblem(results);

  return (
    <div className="space-y-8">
      <Link to={listPath} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" strokeWidth={1.5} /> All experiments
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <FigCaption index="3.12" label="Experiment" />
          <h1 className="mt-4 text-3xl font-medium leading-[1.15] tracking-tight text-ink">{experiment.name}</h1>
          <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <StatusMark status={experiment.status} />
            <span>
              flag <span className="font-mono text-xs text-ink">{experiment.flagKey}</span> in {experiment.environmentName}
            </span>
            <span>
              measures <span className="font-mono text-xs text-ink">{experiment.metricKey}</span>
            </span>
          </p>
          {experiment.hypothesis && <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">Expected: {experiment.hypothesis}</p>}
        </div>

        <div className="flex gap-2">
          {canRun && experiment.status === "DRAFT" && (
            <Button variant="solid" disabled={start.isPending} onClick={() => start.mutate(experiment.id)}>
              {start.isPending ? "Starting" : "Start experiment"}
            </Button>
          )}
          {canRun && experiment.status === "RUNNING" && (
            <Button onClick={() => setConfirming("stop")} disabled={stop.isPending}>
              Stop experiment
            </Button>
          )}
          {canDelete && (
            <Button variant="danger" onClick={() => setConfirming("delete")}>
              Delete
            </Button>
          )}
        </div>
      </header>

      {experiment.status === "DRAFT" && <Checklist results={results} />}

      <section aria-labelledby="groups-title" className="space-y-3">
        <FigCaption id="groups-title" index="3.13" label="The two groups" />
        <div className="grid gap-4 md:grid-cols-2">
          <Group title="Without the flag" note="control" users={results.groups.control.users} conversions={results.groups.control.conversions} />
          <Group title="With the flag" note="treatment" users={results.groups.treatment.users} conversions={results.groups.treatment.conversions} highlight />
        </div>
      </section>

      <section aria-labelledby="result-title" className="space-y-3">
        <FigCaption id="result-title" index="3.14" label="What it means" />
        <Frame className={cn("p-5", text.tone === "waiting" && "border-dashed")}>
          <h2 className="text-lg font-medium tracking-tight text-ink">{text.headline}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{text.detail}</p>
        </Frame>

        {problem && (
          <p role="alert" className="rounded-xs border border-danger/50 px-4 py-3 text-sm leading-relaxed text-danger">
            {problem}
          </p>
        )}
        {!results.sampleRatioChecked && results.groups.control.users + results.groups.treatment.users > 0 && (
          <p className="text-xs leading-relaxed text-faint">The split check is off: targeting rules decide who gets this flag, so the expected share of users with it cannot be known in advance.</p>
        )}
        {experiment.status === "RUNNING" && (
          <p className="max-w-2xl text-xs leading-relaxed text-faint">
            Decide how many users you need before you start, then read the result once. Checking every day and stopping the moment it says "more" or "less" gives a false answer far more often than 1 time in 20.
            Until each group has at least {MIN_USERS_PER_GROUP} users, nothing is concluded. This page refreshes by itself.
          </p>
        )}
      </section>

      <p className="caption text-faint">
        {experiment.startedAt ? `Started ${formatStamp(experiment.startedAt)}` : "Not started"}
        {experiment.stoppedAt ? ` / stopped ${formatStamp(experiment.stoppedAt)}` : ""} / times in UTC
      </p>

      <ConfirmDialog
        open={confirming === "stop"}
        onOpenChange={(open) => !open && setConfirming(null)}
        tone="ink"
        title={`Stop ${experiment.name}?`}
        description="The numbers so far are kept, but no more users are counted. A stopped experiment cannot be restarted: its data would mix two periods. Create a new one instead."
        confirmLabel="Stop experiment"
        onConfirm={() => stop.mutate(experiment.id)}
      />
      <ConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(open) => !open && setConfirming(null)}
        tone="danger"
        title={`Delete ${experiment.name}?`}
        description="The experiment and everything recorded for it are removed. This cannot be undone."
        confirmLabel="Delete experiment"
        onConfirm={() => remove.mutate({ id: experiment.id, name: experiment.name }, { onSuccess: () => void navigate(listPath) })}
      />
    </div>
  );
}

/** What has to be true before Start will work, so the server's refusal is no surprise. */
function Checklist({ results }: { results: ExperimentResults }) {
  const { flagState, experiment } = results;
  const splits = flagState.ruleCount > 0 || (flagState.rolloutPercentage > 0 && flagState.rolloutPercentage < 100);
  const items = [
    { ok: flagState.enabled, text: `${experiment.flagKey} is on in ${experiment.environmentName}`, fix: "Turn it on: while it is off nobody gets the flag." },
    { ok: splits, text: "Some users get the flag and some do not", fix: `The rollout is ${flagState.rolloutPercentage}%. Set it between 1% and 99% (or use targeting rules).` },
  ];
  return (
    <Frame className="p-5">
      <p className="caption text-muted">Before you start</p>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.text} className="flex items-start gap-3 text-sm">
            <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-[1px]", item.ok ? "bg-muted" : "bg-danger")} />
            <span>
              <span className={item.ok ? "text-muted" : "text-ink"}>{item.text}</span>
              {!item.ok && <span className="block text-xs text-faint">{item.fix}</span>}
            </span>
          </li>
        ))}
        <li className="flex items-start gap-3 text-sm text-muted">
          <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-[1px] bg-muted" />
          <span>
            Your code uses an SDK created with <span className="font-mono text-xs text-ink">sendEvents: true</span> and calls <span className="font-mono text-xs text-ink">track("{experiment.metricKey}", user)</span> on success.
          </span>
        </li>
      </ul>
    </Frame>
  );
}

function Group({ title, note, users, conversions, highlight }: { title: string; note: string; users: number; conversions: number; highlight?: boolean }) {
  const rate = users === 0 ? null : conversions / users;
  return (
    <Frame className="p-5" data-group={note}>
      <p className="flex items-baseline justify-between">
        <span className="text-sm text-ink">{title}</span>
        <span className="caption text-faint">{note}</span>
      </p>
      <p className={cn("mt-4 font-mono text-4xl leading-none", highlight ? "text-ink" : "text-muted")} aria-label={rate === null ? "no users yet" : `conversion rate ${percent(rate)}`}>
        {rate === null ? "-" : percent(rate)}
      </p>
      <p className="mt-3 text-xs text-muted">
        <Ticker value={conversions} pad={1} className="text-ink" /> of <Ticker value={users} pad={1} className="text-ink" /> users converted
      </p>
    </Frame>
  );
}
