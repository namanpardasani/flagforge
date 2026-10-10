/**
 * MOCK DATA. Nothing here comes from the server yet.
 * The shapes follow what the real API returns (apps/server), so Prompt 2 can replace the fetchers
 * in mocks/api.ts without changing any component.
 *
 * Timestamps are fixed strings on purpose: the UI must render the same way every time, so
 * screenshots and tests do not drift with the clock.
 */

export type EnvKey = "dev" | "staging" | "prod";
export type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export interface Environment {
  key: EnvKey;
  name: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface Project {
  id: string;
  workspaceSlug: string;
  name: string;
  key: string;
}

export interface FlagState {
  enabled: boolean;
  /** Share of users who get the flag when it is on (0-100). */
  rolloutPercentage: number;
  /** Number of targeting rules. */
  rules: number;
}

export interface Flag {
  id: string;
  projectKey: string;
  key: string;
  name: string;
  description: string;
  updatedAt: string;
  states: Record<EnvKey, FlagState>;
}

export interface Activity {
  id: string;
  projectKey: string;
  at: string;
  actor: string;
  action: "flag.created" | "flag.toggled" | "flag.targeting_updated" | "apikey.created";
  subject: string;
  env?: EnvKey;
  detail: string;
}

export const ENVIRONMENTS: readonly Environment[] = [
  { key: "dev", name: "Development" },
  { key: "staging", name: "Staging" },
  { key: "prod", name: "Production" },
];

export const WORKSPACES: readonly Workspace[] = [
  { id: "ws_halden", name: "Halden Freight", slug: "halden", role: "OWNER" },
  { id: "ws_orchard", name: "Orchard Labs", slug: "orchard", role: "MEMBER" },
];

export const PROJECTS: readonly Project[] = [
  { id: "pr_dispatch", workspaceSlug: "halden", name: "Dispatch API", key: "dispatch-api" },
  { id: "pr_driver", workspaceSlug: "halden", name: "Driver App", key: "driver-app" },
  { id: "pr_billing", workspaceSlug: "halden", name: "Billing", key: "billing" },
  { id: "pr_store", workspaceSlug: "orchard", name: "Storefront", key: "storefront" },
];

const on = (rolloutPercentage = 100, rules = 0): FlagState => ({ enabled: true, rolloutPercentage, rules });
const off = (rules = 0): FlagState => ({ enabled: false, rolloutPercentage: 100, rules });

export const FLAGS: readonly Flag[] = [
  {
    id: "fl_01",
    projectKey: "dispatch-api",
    key: "route-optimizer-v2",
    name: "Route optimizer v2",
    description: "New solver for multi-stop routes. Rolling out by depot.",
    updatedAt: "2026-10-10T11:42:00Z",
    states: { dev: on(), staging: on(), prod: on(25, 1) },
  },
  {
    id: "fl_02",
    projectKey: "dispatch-api",
    key: "carrier-rate-cache",
    name: "Carrier rate cache",
    description: "Serve carrier quotes from cache for five minutes.",
    updatedAt: "2026-10-09T16:05:00Z",
    states: { dev: on(), staging: on(), prod: on() },
  },
  {
    id: "fl_03",
    projectKey: "dispatch-api",
    key: "instant-payouts",
    name: "Instant payouts",
    description: "Pay drivers on delivery instead of weekly.",
    updatedAt: "2026-10-09T09:18:00Z",
    states: { dev: on(), staging: on(100, 2), prod: off(2) },
  },
  {
    id: "fl_04",
    projectKey: "dispatch-api",
    key: "bulk-label-print",
    name: "Bulk label printing",
    description: "Print up to 200 labels in one job.",
    updatedAt: "2026-10-08T14:31:00Z",
    states: { dev: on(), staging: on(50), prod: off() },
  },
  {
    id: "fl_05",
    projectKey: "dispatch-api",
    key: "eta-dark-launch",
    name: "ETA dark launch",
    description: "Compute the new ETA model silently and log the difference.",
    updatedAt: "2026-10-07T10:02:00Z",
    states: { dev: on(), staging: off(), prod: off() },
  },
  {
    id: "fl_06",
    projectKey: "dispatch-api",
    key: "strict-address-check",
    name: "Strict address check",
    description: "Reject orders whose address fails validation.",
    updatedAt: "2026-10-06T08:47:00Z",
    states: { dev: off(), staging: off(), prod: off() },
  },
  {
    id: "fl_07",
    projectKey: "driver-app",
    key: "offline-proof-of-delivery",
    name: "Offline proof of delivery",
    description: "Queue signatures and photos while the phone has no signal.",
    updatedAt: "2026-10-10T07:15:00Z",
    states: { dev: on(), staging: on(), prod: on(60) },
  },
  {
    id: "fl_08",
    projectKey: "driver-app",
    key: "shift-swap",
    name: "Shift swap",
    description: "Let drivers trade shifts without a dispatcher.",
    updatedAt: "2026-10-05T12:20:00Z",
    states: { dev: on(), staging: off(), prod: off() },
  },
  {
    id: "fl_09",
    projectKey: "storefront",
    key: "one-page-checkout",
    name: "One-page checkout",
    description: "Collapse address, shipping and payment into one step.",
    updatedAt: "2026-10-09T18:40:00Z",
    states: { dev: on(), staging: on(), prod: on(10, 1) },
  },
  // "billing" deliberately has no flags, so the empty state has a real place to appear.
];

export const ACTIVITY: readonly Activity[] = [
  { id: "ac_01", projectKey: "dispatch-api", at: "2026-10-10T11:42:00Z", actor: "Mira Okafor", action: "flag.targeting_updated", subject: "route-optimizer-v2", env: "prod", detail: "Rollout 10% to 25%" },
  { id: "ac_02", projectKey: "dispatch-api", at: "2026-10-09T16:05:00Z", actor: "Jonas Reyes", action: "flag.toggled", subject: "carrier-rate-cache", env: "prod", detail: "Turned on" },
  { id: "ac_03", projectKey: "dispatch-api", at: "2026-10-09T09:18:00Z", actor: "Mira Okafor", action: "flag.targeting_updated", subject: "instant-payouts", env: "staging", detail: "Added rule: depot in OSL, BGO" },
  { id: "ac_04", projectKey: "dispatch-api", at: "2026-10-08T14:31:00Z", actor: "Tove Lind", action: "flag.toggled", subject: "bulk-label-print", env: "staging", detail: "Turned on at 50%" },
  { id: "ac_05", projectKey: "dispatch-api", at: "2026-10-08T09:02:00Z", actor: "Jonas Reyes", action: "apikey.created", subject: "ff_7Qm2…", env: "staging", detail: "Key for the staging worker" },
  { id: "ac_06", projectKey: "dispatch-api", at: "2026-10-06T08:47:00Z", actor: "Tove Lind", action: "flag.created", subject: "strict-address-check", detail: "Created, off everywhere" },
  { id: "ac_07", projectKey: "driver-app", at: "2026-10-10T07:15:00Z", actor: "Mira Okafor", action: "flag.targeting_updated", subject: "offline-proof-of-delivery", env: "prod", detail: "Rollout 40% to 60%" },
];

export const CURRENT_USER = { name: "Mira Okafor", email: "mira@halden.example" };
