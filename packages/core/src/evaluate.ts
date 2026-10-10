import { matchCondition } from "./conditions.js";
import { bucketFor } from "./hash.js";
import { BUCKET_COUNT, type EvaluationContext, type EvaluationResult, type FlagConfig } from "./types.js";

function inRollout(flagKey: string, userKey: string, bps: number): boolean {
  if (bps >= BUCKET_COUNT) return true;
  if (bps <= 0) return false;
  return bucketFor(flagKey, userKey) < bps;
}

/**
 * Decides a boolean flag for one user. Order of checks:
 *  1. Flag disabled in this environment -> false (the kill switch beats everything).
 *  2. Rules in order; the FIRST rule whose conditions all match decides, using that rule's rollout.
 *  3. Otherwise the fallthrough rollout decides.
 * Pure and deterministic: same config + same context always gives the same answer, with no I/O.
 */
export function evaluateFlag(config: FlagConfig, context: EvaluationContext): EvaluationResult {
  if (!config.enabled) return { value: false, reason: "OFF" };

  for (const rule of config.rules) {
    if (rule.conditions.every((c) => matchCondition(c, context.attributes))) {
      return {
        value: inRollout(config.key, context.key, rule.rolloutBps),
        reason: "RULE_MATCH",
        ruleId: rule.id,
      };
    }
  }

  return { value: inRollout(config.key, context.key, config.fallthroughBps), reason: "FALLTHROUGH" };
}
