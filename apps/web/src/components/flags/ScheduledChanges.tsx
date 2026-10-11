import { useState, type FormEvent } from "react";
import { envName, isProduction, type EnvKey, type Flag, type Project, type ScheduledChange, type ScheduledChangePatch } from "@/api/types";
import { Frame } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { useScheduledChangeMutations } from "@/data/mutations";
import { useScheduledChanges } from "@/data/queries";
import { buildSchedule, describePatch, earliestLocal, formatLocal, statusLabel, type ScheduleForm } from "@/lib/schedule";
import { cn } from "@/lib/cn";

const EMPTY: ScheduleForm = { when: "", turn: "keep", rollout: "" };

/**
 * Plan a change for later: "at 09:00 Monday, rollout 25%". Several plans make a ramp. The server
 * runs each one by itself (through the same code as pressing the button), and checks again at that
 * moment that whoever planned it may still change flags.
 */
export function ScheduledChanges({ flag, env, project, canEdit }: { flag: Flag; env: EnvKey; project: Project | undefined; canEdit: boolean }) {
  const pending = useScheduledChanges(project, flag.id, "pending");
  const history = useScheduledChanges(project, flag.id, "history");
  const { create, cancel } = useScheduledChangeMutations(project);
  const environment = project?.environments.find((e) => e.key === env);

  const [form, setForm] = useState<ScheduleForm>(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ runAt: string; change: ScheduledChangePatch } | null>(null);
  const [cancelling, setCancelling] = useState<ScheduledChange | null>(null);

  // Only this environment's plans: the page is showing one environment at a time.
  const waiting = (pending.data ?? []).filter((c) => c.environmentKey === env);
  const done = (history.data ?? []).filter((c) => c.environmentKey === env).slice(0, 5);

  const send = (runAt: string, change: ScheduledChangePatch) => {
    if (!environment) return;
    create.mutate({ flagId: flag.id, environmentId: environment.id, runAt, change }, { onSuccess: () => setForm(EMPTY) });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = buildSchedule(form);
    if (!result.ok) return setProblem(result.problem);
    setProblem(null);
    // A plan for Production is deliberate but still a Production change: one extra question.
    if (isProduction(env)) setConfirming({ runAt: result.runAt, change: result.change });
    else send(result.runAt, result.change);
  };

  return (
    <section aria-labelledby="schedule-title">
      <FigCaption id="schedule-title" index="1.8" label="Scheduled changes" />

      {pending.isError ? (
        <p role="alert" className="mt-3 rounded-xs border border-dashed border-hairline px-4 py-6 text-center text-sm text-muted">
          Scheduled changes could not be loaded.
        </p>
      ) : waiting.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Nothing is planned for {envName(env)}.</p>
      ) : (
        <Frame className="mt-3">
          <ol aria-label="Waiting changes">
            {waiting.map((change) => (
              <li key={change.id} className="border-b border-hairline px-4 py-3 last:border-b-0">
                <p className="flex items-baseline justify-between gap-3">
                  <time dateTime={change.runAt} className="font-mono text-xs text-ink">
                    {formatLocal(change.runAt)}
                  </time>
                  {change.status === "RUNNING" && <span className="caption text-faint">running</span>}
                </p>
                <p className="mt-1 text-sm text-muted">{describePatch(change.patch)}</p>
                <p className="mt-1 flex items-center justify-between text-xs text-faint">
                  <span>{change.createdByName ? `by ${change.createdByName}` : ""}</span>
                  {canEdit && change.status === "PENDING" && (
                    <button type="button" onClick={() => setCancelling(change)} aria-label={`Cancel the change planned for ${formatLocal(change.runAt)}`} className="text-muted underline-offset-4 hover:text-ink hover:underline">
                      Cancel
                    </button>
                  )}
                </p>
              </li>
            ))}
          </ol>
        </Frame>
      )}

      {canEdit && environment && (
        <form onSubmit={submit} className="mt-4 space-y-3" aria-label="Plan a change">
          <p className="caption text-muted">Plan a change for {envName(env)}</p>
          <Field label="When" type="datetime-local" min={earliestLocal()} value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} hint="In your time zone." />
          <div>
            <label htmlFor="schedule-turn" className="caption text-muted">
              Turn it
            </label>
            <select id="schedule-turn" value={form.turn} onChange={(e) => setForm({ ...form, turn: e.target.value as ScheduleForm["turn"] })} className="mt-1.5 h-9 w-full rounded-xs border border-hairline bg-sunken px-3 text-sm text-ink hover:border-line-strong">
              <option value="keep">leave as it is</option>
              <option value="on">on</option>
              <option value="off">off</option>
            </select>
          </div>
          <Field label="Rollout to (%)" type="number" inputMode="decimal" min={0} max={100} step="any" value={form.rollout} onChange={(e) => setForm({ ...form, rollout: e.target.value })} hint="Leave empty to keep the current rollout." />
          {(problem || create.error) && (
            <p role="alert" className="text-sm text-danger">
              {problem ?? create.error?.message}
            </p>
          )}
          <Button type="submit" disabled={create.isPending} className="w-full">
            {create.isPending ? "Scheduling" : "Schedule"}
          </Button>
          <p className="text-xs leading-relaxed text-faint">To plan a ramp, schedule one change per step. Targeting rules can be scheduled through the API.</p>
        </form>
      )}

      {done.length > 0 && (
        <div className="mt-6">
          <p className="caption text-muted">Recent</p>
          <ul aria-label="Past scheduled changes" className="mt-2 space-y-2">
            {done.map((change) => (
              <li key={change.id} className="text-xs leading-relaxed text-muted">
                <span className={cn("font-mono", change.status === "FAILED" ? "text-danger" : change.status === "APPLIED" ? "text-ink" : "text-faint")}>{statusLabel(change)}</span> {formatLocal(change.runAt)}: {describePatch(change.patch)}
                {change.failure && <span className="block text-danger">{change.failure}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        tone="ink"
        title={`Schedule a change to ${envName(env)}?`}
        description={confirming ? `At ${formatLocal(confirming.runAt)}, ${describePatch(confirming.change).toLowerCase()} for ${flag.key}. It runs by itself, without anyone pressing a button then.` : ""}
        confirmLabel="Schedule"
        onConfirm={() => confirming && send(confirming.runAt, confirming.change)}
      />
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        tone="danger"
        title="Cancel this scheduled change?"
        description={cancelling ? `${describePatch(cancelling.patch)} at ${formatLocal(cancelling.runAt)} will not happen.` : ""}
        confirmLabel="Cancel the change"
        onConfirm={() => cancelling && cancel.mutate(cancelling.id)}
      />
    </section>
  );
}

