import type { ExperimentResults } from "@/api/types";

/** The least users each group needs before the server gives a verdict (see packages/core/src/stats.ts). */
export const MIN_USERS_PER_GROUP = 100;

/** 0.1234 -> "12.3%" */
export const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/** A difference between two rates, in percentage points, with a sign: 0.03 -> "+3.0 points". */
export const points = (difference: number) => {
  const value = (difference * 100).toFixed(1);
  return `${difference > 0 && Number(value) !== 0 ? "+" : ""}${value} ${value === "1.0" || value === "-1.0" ? "point" : "points"}`;
};

export type ResultTone = "waiting" | "neutral" | "better" | "worse";

export interface ResultText {
  tone: ResultTone;
  headline: string;
  detail: string;
}

/**
 * Says what the numbers mean, in sentences. The wording is deliberate:
 *  - "no difference detected" is never "no effect": too little data cannot show a small effect;
 *  - a difference is described as what the data show, with its interval, not as a promise;
 *  - not having enough data is its own answer, not a guess.
 */
export function describeResult(results: ExperimentResults): ResultText {
  const { analysis, groups } = results;
  const control = groups.control.users;
  const treatment = groups.treatment.users;

  if (!analysis || analysis.verdict === "not_enough_data") {
    const short = Math.max(0, MIN_USERS_PER_GROUP - Math.min(control, treatment));
    return {
      tone: "waiting",
      headline: "Not enough data yet",
      detail:
        control + treatment === 0
          ? "No users have been recorded. Check that your SDK was created with sendEvents on, and that your code calls isEnabled for this flag."
          : `Each group needs at least ${MIN_USERS_PER_GROUP} users, and enough conversions in both. So far: ${control} without the flag, ${treatment} with it${short > 0 ? ` (at least ${short} more users needed in the smaller group)` : ", but too few conversions for a reliable comparison"}.`,
    };
  }

  const interval = analysis.confidenceInterval;
  const range = interval ? `, 95% confidence interval ${points(interval.low)} to ${points(interval.high)}` : "";
  const relative = analysis.relativeLift === null ? "" : ` (${analysis.relativeLift > 0 ? "+" : ""}${(analysis.relativeLift * 100).toFixed(0)}% relative)`;
  const chance = analysis.pValue === null ? "" : ` If the flag did nothing, a difference this large would show up by chance about ${analysis.pValue < 0.001 ? "less than 1 time in 1,000" : `${(analysis.pValue * 100).toFixed(analysis.pValue < 0.1 ? 1 : 0)}% of the time`}.`;

  switch (analysis.verdict) {
    case "treatment_better":
      return { tone: "better", headline: "Users with the flag convert more", detail: `${percent(analysis.treatment.rate)} against ${percent(analysis.control.rate)}: ${points(analysis.absoluteLift)}${relative}${range}.${chance}` };
    case "treatment_worse":
      return { tone: "worse", headline: "Users with the flag convert less", detail: `${percent(analysis.treatment.rate)} against ${percent(analysis.control.rate)}: ${points(analysis.absoluteLift)}${relative}${range}.${chance}` };
    default:
      return {
        tone: "neutral",
        headline: "No difference detected",
        detail: `${percent(analysis.treatment.rate)} with the flag against ${percent(analysis.control.rate)} without${range}.${chance} This does not prove the flag has no effect: a small effect needs more users to show.`,
      };
  }
}

/** Why the split between the groups cannot be trusted, or null when it looks fine (or was not checked). */
export function splitProblem(results: ExperimentResults): string | null {
  const ratio = results.analysis?.sampleRatio;
  if (!ratio?.mismatch) return null;
  const seen = ratio.observedTreatmentShare === null ? "?" : percent(ratio.observedTreatmentShare);
  return `The rollout sends ${percent(ratio.expectedTreatmentShare)} of users to the flag, but ${seen} of the users recorded had it. Something is off in how users are identified or reported, so do not trust these results until you find out what.`;
}
