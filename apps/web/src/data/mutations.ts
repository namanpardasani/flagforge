import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { fromRule } from "@/api/adapters";
import { createExperiment, deleteExperiment, startExperiment, stopExperiment, addMember, changeMemberRole, createApiKey, createEnvironment, deleteEnvironment, removeMember, createFlag, createProject, createWorkspace, fetchFlags, revokeApiKey, saveTargeting, setFlagEnabled } from "@/api/endpoints";
import { connectProjectStream } from "@/api/stream";
import { envName, stateOf, type Role, type EnvKey, type Flag, type FlagState, type Project, type Targeting } from "@/api/types";
import { flash, type FlashKind } from "@/stores/flash";
import { setLiveStatus } from "@/stores/live";
import { toast } from "@/stores/toasts";
import { queryKeys } from "./queries";

/**
 * Writes. Every write here is OPTIMISTIC: the screen changes the instant you act, and the server
 * is told in the background. If the server refuses, the previous data is put back and a toast
 * says so. The alternative (wait for the server, then update) makes every toggle feel laggy.
 *
 * The three steps are always the same:
 *   onMutate  - stop in-flight reads (so a slow read cannot overwrite us), remember the old data,
 *               write the expected result into the cache
 *   onError   - restore what we remembered
 *   onSettled - refetch, so the cache ends up matching the server whatever happened
 */

/** Marks every flag write, so the live stream can tell "a write of ours is in flight". */
const flagWrites = (projectId: string) => ["flag-write", projectId] as const;

function patchFlag(client: QueryClient, projectId: string, flagId: string, update: (flag: Flag) => Flag) {
  client.setQueryData<Flag[]>(queryKeys.flags(projectId), (current) => current?.map((f) => (f.id === flagId ? update(f) : f)));
}

async function begin(client: QueryClient, projectId: string) {
  await client.cancelQueries({ queryKey: queryKeys.flags(projectId) });
  return { previous: client.getQueryData<Flag[]>(queryKeys.flags(projectId)) };
}

function rollback(client: QueryClient, projectId: string, context: { previous?: Flag[] } | undefined, flag: Flag, error: Error) {
  if (context?.previous) client.setQueryData(queryKeys.flags(projectId), context.previous);
  toast(`Could not save ${flag.key}`, { detail: `${error.message.replace(/\.$/, "")}. Nothing was changed.`, tone: "danger" });
}

function settle(client: QueryClient, projectId: string) {
  void client.invalidateQueries({ queryKey: queryKeys.flags(projectId) });
  void client.invalidateQueries({ queryKey: queryKeys.activity(projectId) });
}

interface ToggleInput {
  flag: Flag;
  env: EnvKey;
  enabled: boolean;
  /** "kill" when this came through the production hold-to-confirm. Only changes the flash colour. */
  kind?: FlashKind;
}

export function useSetFlagEnabled(project: Project | undefined) {
  const client = useQueryClient();
  const projectId = project?.id ?? "none";
  return useMutation({
    mutationKey: flagWrites(projectId),
    mutationFn: ({ flag, env, enabled }: ToggleInput) => setFlagEnabled(project!, flag.id, env, enabled),
    onMutate: async ({ flag, env, enabled, kind }) => {
      const context = await begin(client, projectId);
      patchFlag(client, projectId, flag.id, (f) => ({ ...f, states: { ...f.states, [env]: { ...stateOf(f, env), enabled } } }));
      flash(flag.id, kind ?? "local");
      toast(`${flag.key} turned ${enabled ? "on" : "off"}`, { detail: envName(env), tone: enabled ? "live" : kind === "kill" ? "danger" : "neutral" });
      return context;
    },
    onError: (error, { flag }, context) => rollback(client, projectId, context, flag, error),
    onSettled: () => settle(client, projectId),
  });
}

interface TargetingInput {
  flag: Flag;
  env: EnvKey;
  patch: Targeting;
}

export function useSaveTargeting(project: Project | undefined) {
  const client = useQueryClient();
  const projectId = project?.id ?? "none";
  return useMutation({
    mutationKey: flagWrites(projectId),
    mutationFn: ({ flag, env, patch }: TargetingInput) => saveTargeting(project!, flag.id, env, patch),
    onMutate: async ({ flag, env, patch }) => {
      const context = await begin(client, projectId);
      patchFlag(client, projectId, flag.id, (f) => ({ ...f, states: { ...f.states, [env]: { ...stateOf(f, env), ...patch } } }));
      flash(flag.id, "local");
      toast(`Targeting saved for ${flag.key}`, { detail: `${envName(env)}: ${patch.rolloutPercentage}% rollout, ${patch.rules.length} ${patch.rules.length === 1 ? "rule" : "rules"}` });
      return context;
    },
    onError: (error, { flag }, context) => rollback(client, projectId, context, flag, error),
    onSettled: () => settle(client, projectId),
  });
}

export function useCreateFlag(project: Project | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: flagWrites(project?.id ?? "none"),
    mutationFn: (input: { key: string; name: string; description?: string }) => createFlag(project!, input),
    onSuccess: (flag) => {
      client.setQueryData<Flag[]>(queryKeys.flags(project!.id), (current) => (current ? [...current.filter((f) => f.id !== flag.id), flag] : [flag]));
      flash(flag.id, "local");
      toast(`${flag.key} created`, { detail: "Off in every environment until you turn it on." });
    },
    onSettled: () => project && settle(client, project.id),
  });
}

/** First-run setup: a workspace and its first project, one after the other. */
export function useCreateWorkspace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; slug: string; projectName: string; projectKey: string }) => {
      const workspace = await createWorkspace({ name: input.name, slug: input.slug });
      const project = await createProject(workspace.id, { name: input.projectName, key: input.projectKey });
      return { workspace, project };
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.workspaces }),
  });
}

// ---- API keys ------------------------------------------------------------------------------------

export function useCreateApiKey(project: Project | undefined, environmentId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createApiKey(project!, environmentId!, name),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.apiKeys(environmentId ?? "none") }),
  });
}

/** Not optimistic: revoking is a security action, so the row only changes once the server confirms. */
export function useRevokeApiKey(project: Project | undefined, environmentId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (apiKeyId: string) => revokeApiKey(project!, environmentId!, apiKeyId),
    onSuccess: () => toast("Key revoked", { detail: "SDKs using it stop working immediately.", tone: "danger" }),
    onError: (error) => toast("Could not revoke the key", { detail: error.message, tone: "danger" }),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.apiKeys(environmentId ?? "none") }),
  });
}

// ---- members -------------------------------------------------------------------------------------

/**
 * Member changes wait for the server. They are about who may do what, so showing a change that
 * the server then refuses (an admin demoting someone they may not) would be misleading.
 */
export function useMemberMutations(workspaceId: string | undefined) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.members(workspaceId ?? "none") });
  const failed = (title: string) => (error: Error) => toast(title, { detail: error.message, tone: "danger" });
  return {
    add: useMutation({ mutationFn: (input: { email: string; role: Role }) => addMember(workspaceId!, input), onSuccess: (m) => toast(`${m.name} added`, { detail: `As ${m.role.toLowerCase()}.` }), onSettled: refresh }),
    changeRole: useMutation({
      mutationFn: (input: { userId: string; role: Role }) => changeMemberRole(workspaceId!, input.userId, input.role),
      onSuccess: (m) => toast(`${m.name} is now ${m.role.toLowerCase()}`),
      onError: failed("Could not change the role"),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: (input: { userId: string; name: string }) => removeMember(workspaceId!, input.userId),
      onSuccess: (_, input) => toast(`${input.name} removed`),
      onError: failed("Could not remove the member"),
      onSettled: refresh,
    }),
  };
}

// ---- environments --------------------------------------------------------------------------------

/**
 * Environments change the shape of the whole project (every flag gains or loses a column), so after
 * a change the project list and the flags are refetched. Not optimistic: deleting is destructive
 * and creating needs the server to say the key is free.
 */
export function useEnvironmentMutations(project: Project | undefined) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.projects(project?.workspaceId ?? "none") });
    void client.invalidateQueries({ queryKey: queryKeys.flags(project?.id ?? "none") });
  };
  return {
    create: useMutation({
      mutationFn: (input: { name: string; key: string }) => createEnvironment(project!, input),
      onSuccess: (_, input) => toast(`${input.name} created`, { detail: "Every flag starts off here." }),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: (input: { id: string; name: string }) => deleteEnvironment(project!, input.id),
      onSuccess: (_, input) => toast(`${input.name} deleted`, { detail: "Its flag settings and API keys are gone.", tone: "danger" }),
      onError: (error) => toast("Could not delete the environment", { detail: error.message, tone: "danger" }),
      onSettled: refresh,
    }),
  };
}

// ---- experiments ---------------------------------------------------------------------------------

/** Not optimistic: starting depends on rules only the server checks, and stopping or deleting is final. */
export function useExperimentMutations(project: Project | undefined) {
  const client = useQueryClient();
  const projectId = project?.id ?? "none";
  const refresh = (experimentId?: string) => {
    void client.invalidateQueries({ queryKey: queryKeys.experiments(projectId) });
    if (experimentId) void client.invalidateQueries({ queryKey: queryKeys.experiment(experimentId) });
    void client.invalidateQueries({ queryKey: queryKeys.activity(projectId) });
  };
  const failed = (title: string) => (error: Error) => toast(title, { detail: error.message, tone: "danger" });
  return {
    create: useMutation({
      mutationFn: (input: { name: string; hypothesis?: string; flagId: string; environmentId: string; metricKey: string }) => createExperiment(project!, input),
      onSuccess: (experiment) => toast(`${experiment.name} created`, { detail: "A draft. Start it when the flag is set up." }),
      onSettled: () => refresh(),
    }),
    start: useMutation({
      mutationFn: (experimentId: string) => startExperiment(project!, experimentId),
      onSuccess: (experiment) => toast(`${experiment.name} is running`, { detail: "Data counts from now on.", tone: "live" }),
      onError: failed("Could not start the experiment"),
      onSettled: (_, __, experimentId) => refresh(experimentId),
    }),
    stop: useMutation({
      mutationFn: (experimentId: string) => stopExperiment(project!, experimentId),
      onSuccess: (experiment) => toast(`${experiment.name} stopped`, { detail: "The numbers are kept." }),
      onError: failed("Could not stop the experiment"),
      onSettled: (_, __, experimentId) => refresh(experimentId),
    }),
    remove: useMutation({
      mutationFn: (input: { id: string; name: string }) => deleteExperiment(project!, input.id),
      onSuccess: (_, input) => toast(`${input.name} deleted`, { detail: "Its data is gone.", tone: "danger" }),
      onError: failed("Could not delete the experiment"),
      onSettled: () => refresh(),
    }),
  };
}

// ---- live updates --------------------------------------------------------------------------------

/** What a row shows for one environment, reduced to text, so "did anything visible change?" is a string compare. */
const signature = (state: FlagState) =>
  JSON.stringify([state.enabled, state.rolloutPercentage, state.rules.map((rule) => [fromRule(rule).conditions, rule.rolloutPercentage])]);

/**
 * Keeps one project's flags live.
 *
 * The stream only rings a doorbell ("environment X is now at version N"). On a ring this refetches
 * the flags through the normal API, compares them with what was on screen, and flashes exactly
 * the rows that changed in the environment being viewed. A change you made yourself was already
 * put in the cache optimistically, so it compares equal and does not flash as "someone else".
 *
 * After a reconnect the server's hello lists current versions. If any differ from the last ones
 * seen, something was missed while offline, and the same refetch-and-compare runs.
 */
export function useLiveUpdates(project: Project | undefined, env: EnvKey) {
  const client = useQueryClient();
  // Read through a ref, so switching environment does not drop and reopen the stream.
  const viewed = useRef(env);
  useEffect(() => {
    viewed.current = env;
  }, [env]);

  useEffect(() => {
    if (!project) return;
    const key = queryKeys.flags(project.id);
    const known = new Map<string, number>();
    let running: Promise<void> | null = null;
    let again = false;

    const resync = (): Promise<void> => {
      // Bursts are folded together: at most one refetch runs, plus one more if rings arrived meanwhile.
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          // A write of ours is on its way: its own onSettled refetches, and refetching now could
          // briefly put the pre-write data back on screen.
          if (client.isMutating({ mutationKey: flagWrites(project.id) }) > 0) continue;
          const before = client.getQueryData<Flag[]>(key);
          let after: Flag[];
          try {
            after = await client.fetchQuery({ queryKey: key, queryFn: () => fetchFlags(project), staleTime: 0 });
          } catch {
            continue; // the query's own error state and the fallback poll take it from here
          }
          if (!before) continue;
          const env = viewed.current;
          const was = new Map(before.map((f) => [f.id, signature(stateOf(f, env))]));
          for (const flag of after) {
            if (was.get(flag.id) !== signature(stateOf(flag, env))) flash(flag.id, "remote");
          }
          void client.invalidateQueries({ queryKey: queryKeys.activity(project.id) });
        } while (again);
      })().finally(() => {
        running = null;
      });
      return running;
    };

    const stream = connectProjectStream(`/workspaces/${project.workspaceId}/projects/${project.id}/stream`, {
      onStatus: setLiveStatus,
      onHello: (versions) => {
        const first = known.size === 0;
        let missed = false;
        for (const [environmentId, version] of versions) {
          if (!first && known.get(environmentId) !== version) missed = true;
          known.set(environmentId, version);
        }
        if (missed) void resync();
      },
      onChange: ({ environmentId, version }) => {
        if ((known.get(environmentId) ?? -1) >= version) return; // old news (a late or repeated event)
        known.set(environmentId, version);
        void resync();
      },
    });

    return () => {
      stream.close();
      setLiveStatus("off");
    };
  }, [client, project]);
}
