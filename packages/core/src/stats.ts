/**
 * Statistics for A/B experiments on boolean flags: is the difference in conversion rate between
 * the users who got the flag ("treatment") and those who did not ("control") real, or could it
 * be chance?
 *
 * Pure functions with no dependencies, like the rest of this package, so the numbers shown in
 * the dashboard can be reproduced and tested without a server.
 *
 * What this is NOT: it is a fixed-horizon test. It assumes you decide the sample size first and
 * look once at the end. Checking the result every day and stopping the moment it says
 * "significant" makes false positives much more likely than the 5% the test promises.
 */

export interface GroupCounts {
  /** Distinct users who were exposed to this variant. */
  users: number;
  /** Of those, how many did the thing being measured (at most once each). */
  conversions: number;
}

export interface GroupResult extends GroupCounts {
  /** conversions / users, or 0 for an empty group. */
  rate: number;
}

export type ExperimentVerdict =
  /** Too few users or conversions for the test's assumptions to hold. No conclusion. */
  | "not_enough_data"
  /** Enough data, and the difference could easily be chance. This is NOT proof of no effect. */
  | "no_difference_detected"
  | "treatment_better"
  | "treatment_worse";

export interface ExperimentAnalysis {
  control: GroupResult;
  treatment: GroupResult;
  /** treatment.rate - control.rate, in rate units (0.03 means three percentage points). */
  absoluteLift: number;
  /** absoluteLift / control.rate. Null when the control rate is 0 (a ratio would be meaningless). */
  relativeLift: number | null;
  /** Standard score of the difference. Null when there is not enough data. */
  zScore: number | null;
  /** Two-sided: the chance of a difference at least this large if the flag did nothing. */
  pValue: number | null;
  /** 95% confidence interval for absoluteLift. */
  confidenceInterval: { low: number; high: number } | null;
  verdict: ExperimentVerdict;
  /**
   * Sample ratio check. If the rollout says 50% should get the flag but 60% of the users seen did,
   * something is wrong with how users are assigned or counted, and no result should be trusted.
   */
  sampleRatio: {
    expectedTreatmentShare: number;
    observedTreatmentShare: number | null;
    pValue: number | null;
    mismatch: boolean;
  };
}

export interface AnalysisOptions {
  /** The share of users the rollout sends to treatment, 0 to 1 (exclusive). */
  expectedTreatmentShare: number;
  /** Each group needs at least this many users before a verdict is given. Default 100. */
  minUsersPerGroup?: number;
  /** Significance level. Default 0.05. */
  alpha?: number;
}

/** Below this, a sample ratio difference is treated as a real mismatch rather than chance. */
const SAMPLE_RATIO_ALPHA = 0.001;
/** z for a 95% confidence interval. */
const Z_95 = 1.959963984540054;

/**
 * The error function, by the Abramowitz and Stegun formula 7.1.26. Accurate to about 1.5e-7,
 * which is plenty for deciding whether a p-value is above or below 0.05, but it means extremely
 * small p-values (below about 1e-6) are only approximate.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-a * a));
}

/** Chance that a standard normal value is at least this far from zero, in either direction. */
export function twoSidedPValue(z: number): number {
  return Math.min(1, Math.max(0, 1 - erf(Math.abs(z) / Math.SQRT2)));
}

function checkCounts(name: string, group: GroupCounts) {
  const whole = (n: number) => Number.isInteger(n) && n >= 0;
  if (!whole(group.users) || !whole(group.conversions)) throw new RangeError(`${name}: users and conversions must be whole numbers, zero or more`);
  if (group.conversions > group.users) throw new RangeError(`${name}: cannot have more conversions than users`);
}

/**
 * Compares two groups with a two-proportion z-test.
 *
 * The test asks: if both groups truly converted at the same rate, how surprising is the observed
 * difference? It pools both groups to estimate that shared rate, works out how much the
 * difference would wobble by chance (the standard error), and expresses the difference in those
 * units (z). The confidence interval uses each group's own rate instead of the pooled one,
 * because it describes the difference that was seen rather than the "no difference" assumption.
 */
export function analyzeExperiment(controlCounts: GroupCounts, treatmentCounts: GroupCounts, options: AnalysisOptions): ExperimentAnalysis {
  checkCounts("control", controlCounts);
  checkCounts("treatment", treatmentCounts);
  const { expectedTreatmentShare, minUsersPerGroup = 100, alpha = 0.05 } = options;
  if (!(expectedTreatmentShare > 0 && expectedTreatmentShare < 1)) {
    throw new RangeError("expectedTreatmentShare must be between 0 and 1: an experiment needs both groups");
  }

  const rate = (g: GroupCounts) => (g.users === 0 ? 0 : g.conversions / g.users);
  const control: GroupResult = { ...controlCounts, rate: rate(controlCounts) };
  const treatment: GroupResult = { ...treatmentCounts, rate: rate(treatmentCounts) };
  const absoluteLift = treatment.rate - control.rate;
  const relativeLift = control.rate === 0 ? null : absoluteLift / control.rate;

  // ---- sample ratio: did the split come out the way the rollout says it should? ----
  const total = control.users + treatment.users;
  let sampleRatio: ExperimentAnalysis["sampleRatio"] = { expectedTreatmentShare, observedTreatmentShare: null, pValue: null, mismatch: false };
  if (total > 0) {
    const expectedTreatment = total * expectedTreatmentShare;
    const expectedControl = total - expectedTreatment;
    // Chi-squared goodness of fit with one degree of freedom, whose p-value is that of z = sqrt(chi2).
    const chiSquared = (treatment.users - expectedTreatment) ** 2 / expectedTreatment + (control.users - expectedControl) ** 2 / expectedControl;
    const pValue = twoSidedPValue(Math.sqrt(chiSquared));
    // Only judged with a reasonable sample: with a handful of users any split is unremarkable.
    sampleRatio = { expectedTreatmentShare, observedTreatmentShare: treatment.users / total, pValue, mismatch: total >= 2 * minUsersPerGroup && pValue < SAMPLE_RATIO_ALPHA };
  }

  const base = { control, treatment, absoluteLift, relativeLift, sampleRatio };
  const none = { zScore: null, pValue: null, confidenceInterval: null, verdict: "not_enough_data" as const };

  if (control.users < minUsersPerGroup || treatment.users < minUsersPerGroup) return { ...base, ...none };

  // The normal approximation behind the test needs a few successes AND failures in each group.
  const pooled = (control.conversions + treatment.conversions) / total;
  const enough = [control.users, treatment.users].every((n) => n * pooled >= 5 && n * (1 - pooled) >= 5);
  if (!enough) return { ...base, ...none };

  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / control.users + 1 / treatment.users));
  const zScore = absoluteLift / standardError;
  const pValue = twoSidedPValue(zScore);

  const unpooled = Math.sqrt((control.rate * (1 - control.rate)) / control.users + (treatment.rate * (1 - treatment.rate)) / treatment.users);
  const confidenceInterval = { low: absoluteLift - Z_95 * unpooled, high: absoluteLift + Z_95 * unpooled };

  const verdict: ExperimentVerdict = pValue >= alpha ? "no_difference_detected" : absoluteLift > 0 ? "treatment_better" : "treatment_worse";
  return { ...base, zScore, pValue, confidenceInterval, verdict };
}
