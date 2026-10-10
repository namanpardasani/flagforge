import { randomUUID } from "node:crypto";
import type { Rule } from "@flagforge/core";
import { z } from "zod";

const OPERATORS = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

const text = z.string().max(256);
const listItem = z.union([text, z.number().finite()]);

/** Each operator only makes sense with one kind of value; reject the rest at the door. */
const conditionSchema = z
  .object({
    attribute: z.string().min(1).max(100),
    operator: z.enum(OPERATORS),
    value: z.union([text, z.number().finite(), z.boolean(), z.array(listItem).min(1).max(100)]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", path: ["value"], message });
    const isList = Array.isArray(c.value);
    switch (c.operator) {
      case "in":
      case "not_in":
        if (!isList) fail(`${c.operator} needs a list of values`);
        break;
      case "equals":
      case "not_equals":
        if (isList) fail(`${c.operator} needs a single value`);
        break;
      case "contains":
      case "starts_with":
      case "ends_with":
        if (typeof c.value !== "string") fail(`${c.operator} needs a string`);
        break;
      default:
        if (typeof c.value !== "number") fail(`${c.operator} needs a number`);
    }
  });

/** 0..100 with at most two decimals (12.5 is fine, 12.345 is not), stored as basis points. */
export const percentage = z
  .number()
  .min(0)
  .max(100)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "At most 2 decimal places");
export const toBps = (pct: number) => Math.round(pct * 100);
export const toPercentage = (bps: number) => bps / 100;

const ruleInputSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    description: z.string().trim().max(200).optional(),
    conditions: z.array(conditionSchema).min(1).max(10),
    rolloutPercentage: percentage.default(100),
  })
  .strict();

/** Body of PUT .../flags/:flagId/environments/:environmentId. Send only what you want to change. */
export const setFlagStateSchema = z
  .object({
    enabled: z.boolean().optional(),
    rules: z.array(ruleInputSchema).max(20).optional(),
    rolloutPercentage: percentage.optional(),
  })
  .strict()
  .refine(
    (v) => v.enabled !== undefined || v.rules !== undefined || v.rolloutPercentage !== undefined,
    "Provide enabled, rules or rolloutPercentage",
  )
  .refine((v) => {
    const ids = (v.rules ?? []).flatMap((r) => (r.id ? [r.id] : []));
    return new Set(ids).size === ids.length;
  }, "Rule ids must be unique");

export type SetFlagStateInput = z.infer<typeof setFlagStateSchema>;

/** How rules are stored in the database (and sent to SDKs): same shape as @flagforge/core's Rule. */
const storedRuleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  conditions: z.array(conditionSchema).min(1),
  rolloutBps: z.number().int().min(0).max(10000),
});

export function normalizeRules(input: NonNullable<SetFlagStateInput["rules"]>): Rule[] {
  return input.map((r) => ({
    id: r.id ?? randomUUID(),
    ...(r.description ? { description: r.description } : {}),
    conditions: r.conditions,
    rolloutBps: toBps(r.rolloutPercentage),
  }));
}

/** Reads rules back from the JSON column. Corrupt data is a server bug, so it throws (a 500). */
export function parseStoredRules(json: unknown): Rule[] {
  const result = z.array(storedRuleSchema).safeParse(json);
  if (!result.success) throw new Error("Stored targeting rules are invalid");
  return result.data as Rule[];
}

/** API-facing rule: rolloutPercentage instead of rolloutBps. */
export function presentRule(rule: Rule) {
  const { rolloutBps, ...rest } = rule;
  return { ...rest, rolloutPercentage: toPercentage(rolloutBps) };
}
