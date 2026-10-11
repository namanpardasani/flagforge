import type { Condition, Operator } from "@flagforge/core";

/**
 * The shapes the screens work with. They are close to what the server returns but not identical:
 * `adapters.ts` converts between the two, so a change in the API touches one file, not every screen.
 */

/** An environment's key, e.g. "dev" or "prod". Projects can add their own, so this is any string. */
export type EnvKey = string;
export type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Environment {
  id: string;
  key: EnvKey;
  name: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  /** The signed-in user's role here. Used to hide controls; the server enforces it regardless. */
  role: Role;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  environments: Environment[];
}

/**
 * One targeting rule as the form edits it: a single condition plus the share of matching users
 * who get the flag. Rules are checked top to bottom and the first match decides, so ORDER matters.
 */
export interface TargetingRule {
  id: string;
  attribute: string;
  operator: Operator;
  /** Kept as text while editing. Lists ("in") are comma separated; numbers are parsed on save. */
  value: string;
  rolloutPercentage: number;
  /**
   * The server's version of the first condition's value, and the text it was shown as. If the text
   * has not been edited, the original is sent back untouched, so its type (number, boolean, list
   * of numbers) survives a save. Absent on rules created in this form.
   */
  original?: { value: Condition["value"]; text: string };
  /**
   * A server rule may hold several AND-ed conditions; this form edits the first. The others are
   * carried along unchanged so saving never silently drops them.
   */
  more?: Condition[];
  description?: string;
}

export interface FlagState {
  enabled: boolean;
  /** Share of everyone NOT matched by a rule who get the flag when it is on (0-100). */
  rolloutPercentage: number;
  rules: TargetingRule[];
}

export interface Flag {
  id: string;
  projectId: string;
  key: string;
  name: string;
  description: string;
  updatedAt: string;
  /** One entry per environment of the project, by environment key. */
  states: Record<EnvKey, FlagState>;
}

export interface Activity {
  id: string;
  at: string;
  actor: string;
  action: string;
  /** The flag key (or other thing) the entry is about. */
  subject: string;
  env?: EnvKey;
  detail: string;
}

export interface ApiKey {
  id: string;
  name: string;
  /** The first characters of the key, enough to recognise it. The rest is never stored. */
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

/** Roles that can be handed out. Owner is never assignable: ownership cannot be transferred yet. */
export const ASSIGNABLE_ROLES = ["ADMIN", "MEMBER", "VIEWER"] as const satisfies readonly Role[];

/**
 * What one person may do to another member. This MIRRORS the server's rules so the page can offer
 * only what will work; the server still checks every request, and its answer is what counts.
 */
export function memberActions(actor: { id: string; role: Role | undefined }, target: Member) {
  const isSelf = actor.id === target.userId;
  const isOwner = actor.role === "OWNER";
  const isAdmin = actor.role === "ADMIN" || isOwner;
  const targetFixed = target.role === "OWNER";
  const changeRole = !isSelf && !targetFixed && isAdmin && (isOwner || target.role !== "ADMIN");
  return {
    isSelf,
    /** Roles this person may be given by the actor (empty when the role cannot be changed). */
    roles: changeRole ? ASSIGNABLE_ROLES.filter((role) => isOwner || role !== "ADMIN") : [],
    canRemove: !targetFixed && !isSelf && isAdmin && (isOwner || target.role !== "ADMIN"),
    canLeave: isSelf && !targetFixed,
  };
}

export type Targeting = Pick<FlagState, "rolloutPercentage" | "rules">;

const OFF: FlagState = { enabled: false, rolloutPercentage: 100, rules: [] };

/** A flag's state in an environment. An environment the flag knows nothing about is simply "off". */
export const stateOf = (flag: Flag, env: EnvKey): FlagState => flag.states[env] ?? OFF;

/** Changes to these environments need the deliberate hold-to-confirm. */
export const isProduction = (env: EnvKey) => env === "prod" || env === "production";

const hasRole = (role: Role | undefined, minimum: Role) => {
  const order: Role[] = ["VIEWER", "MEMBER", "ADMIN", "OWNER"];
  return role !== undefined && order.indexOf(role) >= order.indexOf(minimum);
};
/**
 * UI convenience only: decides what to show. The server checks the role on every request, so
 * hiding a button is never what keeps someone out.
 */
export const can = {
  editFlags: (role: Role | undefined) => hasRole(role, "MEMBER"),
  readAuditLog: (role: Role | undefined) => hasRole(role, "ADMIN"),
  createProjects: (role: Role | undefined) => hasRole(role, "ADMIN"),
  manageKeys: (role: Role | undefined) => hasRole(role, "ADMIN"),
  manageMembers: (role: Role | undefined) => hasRole(role, "ADMIN"),
};

// Environment names for display. Filled in as projects load (see adapters.ts), so a component can
// turn a key into a name without every caller passing the project around.
const names = new Map<EnvKey, string>([
  ["dev", "Development"],
  ["staging", "Staging"],
  ["prod", "Production"],
]);
export const rememberEnvironments = (environments: readonly Environment[]) => environments.forEach((e) => names.set(e.key, e.name));
export const envName = (key: EnvKey) => names.get(key) ?? key;
