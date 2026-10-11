import { FlaskConical, Plus } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { can } from "@/api/types";
import { Crosshairs, Frame } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { useShell } from "@/components/shell/use-shell";
import { paths, useScope } from "@/components/shell/use-scope";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Problem } from "@/components/ui/problem";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useExperimentMutations } from "@/data/mutations";
import { useExperiments, useFlags } from "@/data/queries";
import { formatStamp, plural } from "@/lib/format";
import { StatusMark } from "./StatusMark";

// The same rule the server applies to metric keys.
const METRIC_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

/**
 * Experiments: A/B tests on a flag. Users who get the flag are compared with users who do not, on
 * one thing your code reports (the metric). Members can create and run them, as with flags.
 */
export function ExperimentsPage() {
  const scope = useScope();
  const experiments = useExperiments(scope.project);
  const canRun = can.runExperiments(scope.role);
  const [creating, setCreating] = useState(false);
  const list = experiments.data ?? [];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <FigCaption index="3.9" label="Experiments" />
          <h1 className="mt-4 text-3xl font-medium leading-[1.15] tracking-tight text-ink">
            Did it <span className="accent text-[1.1em]">work</span>?
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
            An experiment compares the users who get a flag with the users who do not, on one thing your code reports, such as a completed checkout. The flag's rollout decides who is in which group.
          </p>
        </div>
        {canRun && scope.project && (
          <Button variant="solid" onClick={() => setCreating(true)}>
            <Plus strokeWidth={1.5} /> New experiment
          </Button>
        )}
      </header>

      {experiments.isPending ? (
        <SkeletonGroup label="Loading experiments" className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </SkeletonGroup>
      ) : experiments.isError ? (
        <Problem error={experiments.error} what="the experiments" onRetry={() => void experiments.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState fig="3.10" title="No experiments yet" action={canRun ? <Button onClick={() => setCreating(true)}>Create the first experiment</Button> : undefined}>
          Pick a flag that is rolled out to part of your users, name the event that counts as success, and start. FlagForge records who saw what and shows whether the difference is real.
        </EmptyState>
      ) : (
        <>
          <Frame>
            <Table aria-label="Experiments">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Experiment</TableHead>
                  <TableHead className="hidden md:table-cell">Flag</TableHead>
                  <TableHead className="hidden md:table-cell">Environment</TableHead>
                  <TableHead className="w-32">Status</TableHead>
                  <TableHead className="hidden w-36 md:table-cell">Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((experiment) => (
                  <TableRow key={experiment.id}>
                    <TableCell>
                      <Link to={paths.experiment(scope.workspaceSlug, scope.projectKey, experiment.id)} className="block text-ink underline-offset-4 hover:underline">
                        {experiment.name}
                      </Link>
                      <span className="block font-mono text-2xs text-muted">measures {experiment.metricKey}</span>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted md:table-cell">{experiment.flagKey}</TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted md:table-cell">{experiment.environmentName}</TableCell>
                    <TableCell>
                      <StatusMark status={experiment.status} />
                    </TableCell>
                    <TableCell className="hidden font-mono text-2xs text-faint md:table-cell">{experiment.startedAt ? formatStamp(experiment.startedAt) : "not started"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Frame>
          <p className="caption text-faint">
            {list.length} {plural(list.length, "experiment")}
          </p>
        </>
      )}

      <NewExperimentDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewExperimentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const scope = useScope();
  const { env } = useShell();
  const flags = useFlags(scope.project);
  const { create } = useExperimentMutations(scope.project);
  const environments = scope.project?.environments ?? [];

  const [name, setName] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [flagId, setFlagId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [metricKey, setMetricKey] = useState("");

  const chosenFlag = flagId || flags.data?.[0]?.id || "";
  const chosenEnvironment = environmentId || environments.find((e) => e.key === env)?.id || environments[0]?.id || "";
  const metricError = metricKey && (metricKey.length < 2 || !METRIC_PATTERN.test(metricKey)) ? "Lowercase letters, numbers, dots, underscores and hyphens (at least 2)." : null;
  const ready = name.trim().length > 0 && chosenFlag !== "" && chosenEnvironment !== "" && metricKey.length >= 2 && !metricError;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setName("");
      setHypothesis("");
      setFlagId("");
      setEnvironmentId("");
      setMetricKey("");
      create.reset();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || create.isPending) return;
    create.mutate({ name: name.trim(), ...(hypothesis.trim() ? { hypothesis: hypothesis.trim() } : {}), flagId: chosenFlag, environmentId: chosenEnvironment, metricKey }, { onSuccess: () => close(false) });
  };

  const select = "mt-1.5 h-9 w-full rounded-xs border border-hairline bg-sunken px-3 text-sm text-ink hover:border-line-strong";
  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-canvas/80" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-[10vh] z-[60] max-h-[84vh] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto rounded-xs border border-hairline bg-raised p-5 outline-none">
          <Crosshairs />
          <form onSubmit={submit} className="space-y-4">
            <Dialog.Title className="flex items-center gap-2 text-base font-medium tracking-tight text-ink">
              <FlaskConical className="size-4" strokeWidth={1.5} /> New experiment
            </Dialog.Title>
            <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="One-tap checkout converts better" autoFocus required />
            <div>
              <label htmlFor="exp-flag" className="caption text-muted">
                Flag
              </label>
              <select id="exp-flag" value={chosenFlag} onChange={(e) => setFlagId(e.target.value)} className={select} required>
                {(flags.data ?? []).map((flag) => (
                  <option key={flag.id} value={flag.id}>
                    {flag.key}
                  </option>
                ))}
              </select>
              {flags.data?.length === 0 && <p className="mt-1.5 text-xs text-danger">This project has no flags yet. Create one first.</p>}
            </div>
            <div>
              <label htmlFor="exp-env" className="caption text-muted">
                Environment
              </label>
              <select id="exp-env" value={chosenEnvironment} onChange={(e) => setEnvironmentId(e.target.value)} className={select} required>
                {environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </div>
            <Field
              label="Success event"
              mono
              value={metricKey}
              onChange={(e) => setMetricKey(e.target.value.toLowerCase())}
              maxLength={60}
              placeholder="checkout-completed"
              hint="The name your code passes to track(). A user counts once."
              error={metricError}
              required
            />
            <Field label="What you expect (optional)" value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} maxLength={500} hint="Writing it down before you see results keeps you honest." />
            {create.error && (
              <p role="alert" className="text-sm text-danger">
                {create.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="ghost">Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="solid" disabled={!ready || create.isPending}>
                {create.isPending ? "Creating" : "Create experiment"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
