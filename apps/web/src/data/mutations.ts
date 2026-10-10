import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { saveTargeting, setFlagEnabled, subscribeToRemoteChanges, type TargetingPatch } from "@/mocks/api";
import { envName, type EnvKey, type Flag } from "@/mocks/data";
import { flash, type FlashKind } from "@/stores/flash";
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

function patchFlag(client: QueryClient, projectKey: string, flagId: string, update: (flag: Flag) => Flag) {
  client.setQueryData<Flag[]>(queryKeys.flags(projectKey), (current) => current?.map((f) => (f.id === flagId ? update(f) : f)));
}

async function begin(client: QueryClient, projectKey: string) {
  await client.cancelQueries({ queryKey: queryKeys.flags(projectKey) });
  return { previous: client.getQueryData<Flag[]>(queryKeys.flags(projectKey)) };
}

function rollback(client: QueryClient, projectKey: string, context: { previous?: Flag[] } | undefined, flag: Flag, error: Error) {
  if (context?.previous) client.setQueryData(queryKeys.flags(projectKey), context.previous);
  toast(`Could not save ${flag.key}`, { detail: `${error.message}. Nothing was changed.`, tone: "danger" });
}

function settle(client: QueryClient, projectKey: string) {
  void client.invalidateQueries({ queryKey: queryKeys.flags(projectKey) });
  void client.invalidateQueries({ queryKey: queryKeys.activity(projectKey) });
}

interface ToggleInput {
  flag: Flag;
  env: EnvKey;
  enabled: boolean;
  /** "kill" when this came through the production hold-to-confirm. Only changes the flash colour. */
  kind?: FlashKind;
}

export function useSetFlagEnabled(projectKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ flag, env, enabled }: ToggleInput) => setFlagEnabled(flag.id, env, enabled),
    onMutate: async ({ flag, env, enabled, kind }) => {
      const context = await begin(client, projectKey);
      patchFlag(client, projectKey, flag.id, (f) => ({ ...f, states: { ...f.states, [env]: { ...f.states[env], enabled } } }));
      flash(flag.id, kind ?? "local");
      toast(`${flag.key} turned ${enabled ? "on" : "off"}`, { detail: envName(env), tone: enabled ? "live" : kind === "kill" ? "danger" : "neutral" });
      return context;
    },
    onError: (error, { flag }, context) => rollback(client, projectKey, context, flag, error),
    onSettled: () => settle(client, projectKey),
  });
}

interface TargetingInput {
  flag: Flag;
  env: EnvKey;
  patch: TargetingPatch;
}

export function useSaveTargeting(projectKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ flag, env, patch }: TargetingInput) => saveTargeting(flag.id, env, patch),
    onMutate: async ({ flag, env, patch }) => {
      const context = await begin(client, projectKey);
      patchFlag(client, projectKey, flag.id, (f) => ({ ...f, states: { ...f.states, [env]: { ...f.states[env], ...patch } } }));
      flash(flag.id, "local");
      toast(`Targeting saved for ${flag.key}`, { detail: `${envName(env)}: ${patch.rolloutPercentage}% rollout, ${patch.rules.length} ${patch.rules.length === 1 ? "rule" : "rules"}` });
      return context;
    },
    onError: (error, { flag }, context) => rollback(client, projectKey, context, flag, error),
    onSettled: () => settle(client, projectKey),
  });
}

/**
 * Applies changes made by someone else as they arrive, and flashes the row.
 * Today the events come from the dev panel (mocks/api.ts). Later this subscribes to the real SSE
 * stream instead; the cache update and the flash stay exactly the same.
 */
export function useRemoteUpdates(projectKey: string) {
  const client = useQueryClient();
  useEffect(
    () =>
      subscribeToRemoteChanges((change) => {
        if (change.flag.projectKey !== projectKey) return;
        patchFlag(client, projectKey, change.flag.id, () => change.flag);
        void client.invalidateQueries({ queryKey: queryKeys.activity(projectKey) });
        flash(change.flag.id, "remote");
      }),
    [client, projectKey],
  );
}
