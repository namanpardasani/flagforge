import { bucketFor, type Operator } from "@flagforge/core";
import type { FlagState, TargetingRule } from "@/mocks/data";

export const OPERATORS: readonly { value: Operator; label: string; kind: "text" | "list" | "number" }[] = [
  { value: "equals", label: "is", kind: "text" },
  { value: "not_equals", label: "is not", kind: "text" },
  { value: "in", label: "is one of", kind: "list" },
  { value: "not_in", label: "is none of", kind: "list" },
  { value: "contains", label: "contains", kind: "text" },
  { value: "starts_with", label: "starts with", kind: "text" },
  { value: "ends_with", label: "ends with", kind: "text" },
  { value: "gt", label: "greater than", kind: "number" },
  { value: "gte", label: "at least", kind: "number" },
  { value: "lt", label: "less than", kind: "number" },
  { value: "lte", label: "at most", kind: "number" },
];

export const operatorKind = (operator: Operator) => OPERATORS.find((o) => o.value === operator)?.kind ?? "text";

/** Attributes offered as suggestions. Any name can be typed; these are just the common ones. */
export const ATTRIBUTE_HINTS = ["plan", "country", "depot", "appVersion", "tenureMonths", "email"] as const;

export const newRule = (): TargetingRule => ({ id: crypto.randomUUID(), attribute: "", operator: "equals", value: "", rolloutPercentage: 100 });

/** What is wrong with a rule, in words a person can act on. Null means it is fine. Mirrors the server's checks. */
export function validateRule(rule: TargetingRule): string | null {
  if (!rule.attribute.trim()) return "Name the attribute to check.";
  const value = rule.value.trim();
  if (!value) return "Give a value to compare against.";
  const kind = operatorKind(rule.operator);
  if (kind === "number" && !Number.isFinite(Number(value))) return "This comparison needs a number.";
  if (kind === "list" && value.split(",").every((part) => !part.trim())) return "List at least one value, separated by commas.";
  if (!Number.isFinite(rule.rolloutPercentage) || rule.rolloutPercentage < 0 || rule.rolloutPercentage > 100) return "Serve between 0 and 100 percent.";
  return null;
}

export type Targeting = Pick<FlagState, "rolloutPercentage" | "rules">;

/** Compares two targeting drafts by content. Used to decide whether there is anything to save. */
export const sameTargeting = (a: Targeting, b: Targeting) => JSON.stringify(a) === JSON.stringify(b);

// ---- rollout preview -----------------------------------------------------------------------------

export const SAMPLE_SIZE = 100;
const BUCKETS = 10_000;
const BAND = BUCKETS / SAMPLE_SIZE; // 100 buckets = one percentage point

/**
 * 100 sample users for a flag, with their buckets (0-9999) from the REAL bucketing function in
 * @flagforge/core, the same one the SDK and the server use.
 *
 * The users are chosen so there is exactly one in each 1% band of the bucket range. Picking 100
 * users at random would be just as "real", but 25% would then light anywhere from about 17 to 33
 * squares, which reads as a broken preview. Spread evenly, N% lights exactly N squares, while each
 * square is still a genuine user key hashed by the genuine function.
 *
 * They are returned in the order they were found, not sorted by bucket, so the lit squares are
 * scattered across the grid the way real users are scattered across a rollout.
 */
export function sampleBuckets(flagKey: string): number[] {
  const byBand = new Map<number, number>();
  const order: number[] = [];
  // About 520 candidates fill all 100 bands on average; the cap only guards against an endless loop.
  for (let i = 1; byBand.size < SAMPLE_SIZE && i <= 50_000; i++) {
    const bucket = bucketFor(flagKey, `sample-user-${i}`);
    const band = Math.floor(bucket / BAND);
    if (!byBand.has(band)) {
      byBand.set(band, bucket);
      order.push(bucket);
    }
  }
  return order;
}

/** A user is in a rollout when their bucket is below the cut-off (percentage x 100, since there are 10000 buckets). */
export const isIncluded = (bucket: number, percentage: number) => bucket < percentage * BAND;
