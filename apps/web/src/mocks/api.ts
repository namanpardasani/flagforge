import {
  ACTIVITY,
  CURRENT_USER,
  FLAGS,
  PROJECTS,
  REMOTE_ACTOR,
  WORKSPACES,
  type Activity,
  type EnvKey,
  type Flag,
  type FlagState,
  type Project,
  type Workspace,
} from "./data";

/**
 * A pretend server. It keeps its own mutable copy of the data (like a database), answers after a
 * short delay, can be told to fail, and can push "someone else changed this" events (the stand-in
 * for the real SSE stream). A later step replaces the function bodies with `fetch` calls; the
 * signatures stay, so no component changes.
 */

const LATENCY_MS = import.meta.env.MODE === "test" ? 0 : 420;
const wait = () => new Promise<void>((resolve) => setTimeout(resolve, LATENCY_MS));
const clone = <T>(value: T): T => structuredClone(value);

let flags: Flag[] = clone([...FLAGS]);
let activity: Activity[] = clone([...ACTIVITY]);
let failNextWrite = false;
let sequence = 0;
let remoteTurn = 0;

/** Tests call this so one test's edits cannot leak into the next. */
export function resetMockServer() {
  flags = clone([...FLAGS]);
  activity = clone([...ACTIVITY]);
  failNextWrite = false;
  sequence = 0;
  remoteTurn = 0;
  listeners.clear();
}

/** Dev panel: make the next write fail, to show optimistic updates rolling back. */
export function setFailNextWrite(value: boolean) {
  failNextWrite = value;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function writeGuard() {
  if (failNextWrite) {
    failNextWrite = false;
    throw new ApiError("The server refused the change", 503);
  }
}

const now = () => new Date().toISOString();

function record(entry: Omit<Activity, "id" | "at">): Activity {
  const saved: Activity = { ...entry, id: `ac_new_${++sequence}`, at: now() };
  activity = [saved, ...activity];
  return saved;
}

function requireFlag(flagId: string): Flag {
  const flag = flags.find((f) => f.id === flagId);
  if (!flag) throw new ApiError("Flag not found", 404);
  return flag;
}

// ---- reads -------------------------------------------------------------------------------------

export const fetchWorkspaces = async (): Promise<Workspace[]> => {
  await wait();
  return [...WORKSPACES];
};

export const fetchProjects = async (workspaceSlug: string): Promise<Project[]> => {
  await wait();
  return PROJECTS.filter((p) => p.workspaceSlug === workspaceSlug);
};

export const fetchFlags = async (projectKey: string): Promise<Flag[]> => {
  await wait();
  return clone(flags.filter((f) => f.projectKey === projectKey));
};

export const fetchActivity = async (projectKey: string): Promise<Activity[]> => {
  await wait();
  return clone(activity.filter((a) => a.projectKey === projectKey));
};

// ---- writes ------------------------------------------------------------------------------------

export async function setFlagEnabled(flagId: string, env: EnvKey, enabled: boolean): Promise<Flag> {
  await wait();
  writeGuard();
  const flag = requireFlag(flagId);
  if (flag.states[env].enabled !== enabled) {
    flag.states[env].enabled = enabled;
    flag.updatedAt = now();
    record({ projectKey: flag.projectKey, actor: CURRENT_USER.name, action: "flag.toggled", subject: flag.key, env, detail: enabled ? "Turned on" : "Turned off" });
  }
  return clone(flag);
}

export type TargetingPatch = Pick<FlagState, "rolloutPercentage" | "rules">;

export async function saveTargeting(flagId: string, env: EnvKey, patch: TargetingPatch): Promise<Flag> {
  await wait();
  writeGuard();
  const flag = requireFlag(flagId);
  const before = flag.states[env];
  const detail =
    before.rolloutPercentage !== patch.rolloutPercentage
      ? `Rollout ${before.rolloutPercentage}% to ${patch.rolloutPercentage}%`
      : `Rules updated (${patch.rules.length})`;
  flag.states[env] = { ...before, rolloutPercentage: patch.rolloutPercentage, rules: clone(patch.rules) };
  flag.updatedAt = now();
  record({ projectKey: flag.projectKey, actor: CURRENT_USER.name, action: "flag.targeting_updated", subject: flag.key, env, detail });
  return clone(flag);
}

// ---- pushed updates (stand-in for the SSE stream) -----------------------------------------------

export interface RemoteChange {
  flag: Flag;
  env: EnvKey;
  actor: string;
  detail: string;
}

const listeners = new Set<(change: RemoteChange) => void>();

/** Listen for changes made by someone else. Returns an unsubscribe function. */
export function subscribeToRemoteChanges(listener: (change: RemoteChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Dev panel: pretend a teammate changed a flag. Picks the next flag in the project in turn (so it
 * is predictable, not random), flips it or nudges its rollout, and pushes the result to listeners.
 */
export function simulateRemoteChange(projectKey: string, env: EnvKey): RemoteChange | null {
  const candidates = flags.filter((f) => f.projectKey === projectKey);
  if (candidates.length === 0) return null;
  const flag = candidates[remoteTurn++ % candidates.length]!;
  const state = flag.states[env];

  let detail: string;
  if (state.enabled && state.rolloutPercentage < 100) {
    const next = Math.min(100, state.rolloutPercentage + 10);
    detail = `Rollout ${state.rolloutPercentage}% to ${next}%`;
    state.rolloutPercentage = next;
  } else {
    state.enabled = !state.enabled;
    detail = state.enabled ? "Turned on" : "Turned off";
  }
  flag.updatedAt = now();
  record({ projectKey, actor: REMOTE_ACTOR, action: detail.startsWith("Rollout") ? "flag.targeting_updated" : "flag.toggled", subject: flag.key, env, detail });

  const change: RemoteChange = { flag: clone(flag), env, actor: REMOTE_ACTOR, detail };
  for (const listener of [...listeners]) listener(change);
  return change;
}
