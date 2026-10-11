import type { Condition, Operator } from "@flagforge/core";
import { z } from "zod";
import { rememberEnvironments, type ScheduledChange, type Experiment, type ExperimentResults, type ApiKey, type Member, type Activity, type Environment, type Flag, type FlagState, type Project, type TargetingRule, type User, type Workspace } from "./types";

/**
 * What the server sends (checked with Zod as it arrives) and how it becomes what the screens use.
 * Unknown extra fields are ignored, so the server can add things without breaking this app.
 */

const OPERATORS = ["equals", "not_equals", "in", "not_in", "contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte"] as const satisfies readonly Operator[];
const LIST_OPERATORS: readonly Operator[] = ["in", "not_in"];
const NUMBER_OPERATORS: readonly Operator[] = ["gt", "gte", "lt", "lte"];

export const userSchema = z.object({ id: z.string(), name: z.string(), email: z.string(), emailVerified: z.boolean() });
export const sessionSchema = z.object({ user: userSchema, accessToken: z.string(), refreshToken: z.string() });
export const meSchema = z.object({ user: userSchema });

const workspaceSchema = z.object({ id: z.string(), name: z.string(), slug: z.string(), role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]) });
export const workspacesSchema = z.object({ workspaces: z.array(workspaceSchema) });
export { workspaceSchema };

const environmentSchema = z.object({ id: z.string(), key: z.string(), name: z.string(), createdAt: z.string() });
export { environmentSchema };
export const projectSchema = z.object({ id: z.string(), workspaceId: z.string(), name: z.string(), key: z.string(), environments: z.array(environmentSchema) });
export const projectsSchema = z.object({ projects: z.array(projectSchema) });

const conditionSchema = z.object({
  attribute: z.string(),
  operator: z.enum(OPERATORS),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
});
const ruleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  conditions: z.array(conditionSchema).min(1),
  rolloutPercentage: z.number(),
});
export const flagSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  updatedAt: z.string(),
  environments: z.array(
    z.object({
      environmentId: z.string(),
      key: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      rules: z.array(ruleSchema),
      rolloutPercentage: z.number(),
      updatedAt: z.string().nullable().optional(),
    }),
  ),
});
export const flagsSchema = z.object({ flags: z.array(flagSchema) });

const auditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  metadata: z.unknown(),
  createdAt: z.string(),
  actor: z.object({ name: z.string() }).nullable(),
});
export const auditSchema = z.object({ entries: z.array(auditEntrySchema), nextCursor: z.string().nullable().optional() });
type AuditEntry = z.infer<typeof auditEntrySchema>;

type ServerRule = z.infer<typeof ruleSchema>;
type ServerFlag = z.infer<typeof flagSchema>;

export const toUser = (user: z.infer<typeof userSchema>): User => ({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified });
export const toWorkspace = (w: z.infer<typeof workspaceSchema>): Workspace => ({ id: w.id, name: w.name, slug: w.slug, role: w.role });

export function toProject(project: z.infer<typeof projectSchema>): Project {
  const environments: Environment[] = project.environments.map((e) => ({ id: e.id, key: e.key, name: e.name, createdAt: e.createdAt }));
  rememberEnvironments(environments);
  return { id: project.id, workspaceId: project.workspaceId, name: project.name, key: project.key, environments };
}

/** A condition's value as the text shown in the form. Lists become "a, b, c". */
const valueText = (value: Condition["value"]) => (Array.isArray(value) ? value.join(", ") : String(value));

function toRule(rule: ServerRule): TargetingRule {
  const [first, ...more] = rule.conditions as [Condition, ...Condition[]];
  const text = valueText(first.value);
  return {
    id: rule.id,
    attribute: first.attribute,
    operator: first.operator,
    value: text,
    rolloutPercentage: rule.rolloutPercentage,
    original: { value: first.value, text },
    ...(more.length > 0 ? { more } : {}),
    ...(rule.description ? { description: rule.description } : {}),
  };
}

export function toFlag(flag: ServerFlag): Flag {
  const states: Record<string, FlagState> = {};
  let updatedAt = flag.updatedAt;
  for (const e of flag.environments) {
    states[e.key] = { enabled: e.enabled, rolloutPercentage: e.rolloutPercentage, rules: e.rules.map(toRule) };
    // A toggle changes the environment's state, not the flag row, so "last updated" is the newest of both.
    if (e.updatedAt && e.updatedAt > updatedAt) updatedAt = e.updatedAt;
  }
  return { id: flag.id, projectId: flag.projectId, key: flag.key, name: flag.name, description: flag.description ?? "", updatedAt, states };
}

/**
 * The form holds every value as text; the server wants the right type for the operator.
 *  - comparisons (gt, lt...) need a number;
 *  - "one of" needs a list;
 *  - everything else typed here is sent as text.
 * A value that was not edited goes back exactly as the server gave it, so a rule made through the
 * API with a number or a boolean keeps its type when you only change something else.
 */
function conditionValue(rule: TargetingRule): Condition["value"] {
  const text = rule.value.trim();
  if (rule.original && rule.original.text === rule.value && fits(rule.operator, rule.original.value)) return rule.original.value;
  if (NUMBER_OPERATORS.includes(rule.operator)) return Number(text);
  if (LIST_OPERATORS.includes(rule.operator)) return text.split(",").map((part) => part.trim()).filter(Boolean);
  return text;
}

/** Does a stored value still suit the operator? (The operator may have been changed in the form.) */
function fits(operator: Operator, value: Condition["value"]): boolean {
  if (LIST_OPERATORS.includes(operator)) return Array.isArray(value);
  if (NUMBER_OPERATORS.includes(operator)) return typeof value === "number";
  if (operator === "equals" || operator === "not_equals") return !Array.isArray(value);
  return typeof value === "string";
}

export function fromRule(rule: TargetingRule) {
  return {
    id: rule.id,
    ...(rule.description ? { description: rule.description } : {}),
    conditions: [{ attribute: rule.attribute.trim(), operator: rule.operator, value: conditionValue(rule) }, ...(rule.more ?? [])],
    rolloutPercentage: rule.rolloutPercentage,
  };
}

/** A moment in UTC, short, for audit lines (the log says "times in UTC"). */
const formatWhen = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(iso));

const percent = (bps: unknown) => (typeof bps === "number" ? `${bps / 100}%` : "?");

/** Turns one audit-log row into the short line the screens show. */
export function toAuditEntry(entry: AuditEntry): Activity {
  const meta = (entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);

  let detail = entry.action;
  let subject = text(meta["key"]) ?? entry.entityId;
  if (entry.action === "flag.toggled") detail = meta["to"] === true ? "Turned on" : "Turned off";
  else if (entry.action === "flag.created") detail = "Created";
  else if (entry.action === "flag.deleted") detail = "Deleted";
  else if (entry.action === "flag.updated") detail = "Name or description changed";
  else if (entry.action === "flag.targeting_updated") {
    const before = (meta["before"] ?? {}) as { fallthroughBps?: unknown; rules?: unknown[] };
    const after = (meta["after"] ?? {}) as { fallthroughBps?: unknown; rules?: unknown[] };
    detail = before.fallthroughBps !== after.fallthroughBps ? `Rollout ${percent(before.fallthroughBps)} to ${percent(after.fallthroughBps)}` : `Rules updated (${after.rules?.length ?? 0})`;
  } else if (entry.action.startsWith("flag.schedule_")) {
    const planned = (meta["change"] ?? {}) as { enabled?: boolean; rolloutPercentage?: number };
    const what = [planned.enabled === undefined ? null : planned.enabled ? "turn on" : "turn off", planned.rolloutPercentage === undefined ? null : `rollout ${planned.rolloutPercentage}%`].filter(Boolean).join(", ");
    const when = typeof meta["runAt"] === "string" ? formatWhen(meta["runAt"]) : "later";
    detail =
      entry.action === "flag.schedule_created" ? `Scheduled for ${when}${what ? `: ${what}` : ""}` :
      entry.action === "flag.schedule_applied" ? `Scheduled change applied (planned for ${when})` :
      entry.action === "flag.schedule_cancelled" ? `Scheduled change cancelled (was for ${when})` :
      entry.action === "flag.schedule_failed" ? `Scheduled change failed: ${text(meta["failure"]) ?? "unknown reason"}` : entry.action;
  } else if (entry.entityType === "experiment") {
    const name = text(meta["name"]);
    const label = name ? `"${name}"` : "experiment";
    detail =
      entry.action === "experiment.created" ? `Created experiment ${label}` :
      entry.action === "experiment.started" ? `Started experiment ${label}` :
      entry.action === "experiment.stopped" ? `Stopped experiment ${label}` :
      entry.action === "experiment.deleted" ? `Deleted experiment ${label}` : entry.action;
  } else if (entry.entityType === "api_key") {
    subject = text(meta["name"]) ?? text(meta["prefix"]) ?? entry.entityId;
    const prefix = text(meta["prefix"]);
    detail = entry.action === "apikey.created" ? `Created key${prefix ? ` ${prefix}…` : ""}` : entry.action === "apikey.revoked" ? `Revoked key${prefix ? ` ${prefix}…` : ""}` : entry.action;
  }
  return {
    id: entry.id,
    at: entry.createdAt,
    actor: entry.actor?.name ?? "Someone who has left",
    action: entry.action,
    subject,
    ...(text(meta["environmentKey"]) ? { env: text(meta["environmentKey"])! } : {}),
    detail,
  };
}

/** The flag history of one project, from the workspace-wide log. Rows about other projects are dropped. */
export function toActivity(entries: AuditEntry[], project: Project, flags: readonly Flag[]): Activity[] {
  const flagIds = new Set(flags.map((f) => f.id));
  return entries
    .filter((entry) => {
      const meta = (entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}) as Record<string, unknown>;
      return entry.entityType === "flag" && (flagIds.has(entry.entityId) || meta["projectId"] === project.id);
    })
    .map(toAuditEntry);
}

const apiKeySchema = z.object({ id: z.string(), name: z.string(), prefix: z.string(), createdAt: z.string(), revokedAt: z.string().nullable() });
export const apiKeysSchema = z.object({ apiKeys: z.array(apiKeySchema) });
/** Only a brand-new key carries the full secret; the server never returns it again. */
export const createdApiKeySchema = apiKeySchema.extend({ key: z.string() });
export const toApiKey = (key: z.infer<typeof apiKeySchema>): ApiKey => ({ id: key.id, name: key.name, prefix: key.prefix, createdAt: key.createdAt, revokedAt: key.revokedAt });

const memberSchema = z.object({
  userId: z.string(),
  role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]),
  joinedAt: z.string(),
  user: z.object({ email: z.string(), name: z.string() }),
});
export const membersSchema = z.object({ members: z.array(memberSchema) });
export { memberSchema };
export const toMember = (m: z.infer<typeof memberSchema>): Member => ({ userId: m.userId, name: m.user.name, email: m.user.email, role: m.role, joinedAt: m.joinedAt });

const groupCounts = z.object({ users: z.number(), conversions: z.number() });
const groupResult = groupCounts.extend({ rate: z.number() });
const experimentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  flagId: z.string(),
  name: z.string(),
  hypothesis: z.string().nullable(),
  metricKey: z.string(),
  status: z.enum(["DRAFT", "RUNNING", "STOPPED"]),
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  createdAt: z.string(),
  flag: z.object({ key: z.string(), name: z.string() }),
  environment: z.object({ key: z.string(), name: z.string() }),
});
export { experimentSchema };
export const experimentsSchema = z.object({ experiments: z.array(experimentSchema) });
const analysisSchema = z.object({
  control: groupResult,
  treatment: groupResult,
  absoluteLift: z.number(),
  relativeLift: z.number().nullable(),
  zScore: z.number().nullable(),
  pValue: z.number().nullable(),
  confidenceInterval: z.object({ low: z.number(), high: z.number() }).nullable(),
  verdict: z.enum(["not_enough_data", "no_difference_detected", "treatment_better", "treatment_worse"]),
  sampleRatio: z.object({ expectedTreatmentShare: z.number(), observedTreatmentShare: z.number().nullable(), pValue: z.number().nullable(), mismatch: z.boolean() }),
});
export const resultsSchema = experimentSchema.extend({
  flagState: z.object({ enabled: z.boolean(), rolloutPercentage: z.number(), ruleCount: z.number() }),
  groups: z.object({ control: groupCounts, treatment: groupCounts }),
  analysis: analysisSchema.nullable(),
  sampleRatioChecked: z.boolean(),
});

export const toExperiment = (e: z.infer<typeof experimentSchema>): Experiment => ({
  id: e.id,
  projectId: e.projectId,
  name: e.name,
  hypothesis: e.hypothesis ?? "",
  metricKey: e.metricKey,
  status: e.status,
  flagId: e.flagId,
  flagKey: e.flag.key,
  flagName: e.flag.name,
  environmentId: e.environmentId,
  environmentKey: e.environment.key,
  environmentName: e.environment.name,
  startedAt: e.startedAt,
  stoppedAt: e.stoppedAt,
  createdAt: e.createdAt,
});

export const toResults = (r: z.infer<typeof resultsSchema>): ExperimentResults => ({
  experiment: toExperiment(r),
  flagState: r.flagState,
  groups: r.groups,
  analysis: r.analysis,
  sampleRatioChecked: r.sampleRatioChecked,
});

const scheduledSchema = z.object({
  id: z.string(),
  flagId: z.string(),
  environmentId: z.string(),
  runAt: z.string(),
  patch: z.object({ enabled: z.boolean().optional(), rolloutPercentage: z.number().optional(), rules: z.array(z.unknown()).optional() }).passthrough(),
  status: z.enum(["PENDING", "RUNNING", "APPLIED", "CANCELLED", "FAILED"]),
  appliedAt: z.string().nullable(),
  failure: z.string().nullable(),
  createdBy: z.object({ name: z.string() }).nullable(),
  flag: z.object({ key: z.string() }),
  environment: z.object({ key: z.string(), name: z.string() }),
});
export { scheduledSchema };
export const scheduledListSchema = z.object({ scheduledChanges: z.array(scheduledSchema) });
export const toScheduledChange = (c: z.infer<typeof scheduledSchema>): ScheduledChange => ({
  id: c.id,
  flagId: c.flagId,
  flagKey: c.flag.key,
  environmentKey: c.environment.key,
  environmentName: c.environment.name,
  runAt: c.runAt,
  patch: c.patch,
  status: c.status,
  appliedAt: c.appliedAt,
  failure: c.failure,
  createdByName: c.createdBy?.name ?? null,
});
