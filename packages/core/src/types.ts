/** Total number of rollout buckets. 10000 buckets means 0.01% resolution (12.5% = 1250). */
export const BUCKET_COUNT = 10000;

export type AttributeValue = string | number | boolean | string[];
export type Attributes = Record<string, AttributeValue | undefined>;

/** Who we are evaluating for. `key` is the stable user id that decides rollout bucketing. */
export interface EvaluationContext {
  key: string;
  attributes?: Attributes;
}

export type Operator =
  | "equals"
  | "not_equals"
  | "in"
  | "not_in"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export type ConditionValue = string | number | boolean | Array<string | number>;

export interface Condition {
  attribute: string;
  operator: Operator;
  value: ConditionValue;
}

/** All conditions must match (AND). Matching users then get `true` for `rolloutBps` / 10000 of buckets. */
export interface Rule {
  id: string;
  description?: string;
  conditions: Condition[];
  rolloutBps: number;
}

/** A flag's complete configuration in ONE environment. */
export interface FlagConfig {
  key: string;
  enabled: boolean;
  rules: Rule[];
  /** Share of everyone not matched by a rule who get `true`, in basis points (0..10000). */
  fallthroughBps: number;
}

export type EvaluationReason = "OFF" | "RULE_MATCH" | "FALLTHROUGH";

export interface EvaluationResult {
  value: boolean;
  reason: EvaluationReason;
  /** Set when reason is RULE_MATCH. */
  ruleId?: string;
}
