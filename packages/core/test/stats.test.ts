import { describe, expect, it } from "vitest";
import { analyzeExperiment, twoSidedPValue } from "../src/index.js";

const half = { expectedTreatmentShare: 0.5 };

describe("twoSidedPValue", () => {
  // Reference values from Python's math.erfc, which is a different implementation.
  it("matches reference values for the usual thresholds", () => {
    expect(twoSidedPValue(0)).toBeCloseTo(1, 6);
    expect(twoSidedPValue(1)).toBeCloseTo(0.31731051, 6);
    expect(twoSidedPValue(1.959963984540054)).toBeCloseTo(0.05, 6);
    expect(twoSidedPValue(2.5758293035489)).toBeCloseTo(0.01, 6);
    expect(twoSidedPValue(3.2905267314919)).toBeCloseTo(0.001, 6);
  });

  it("is symmetric and stays within 0 and 1", () => {
    for (const z of [0.3, 1.7, 4, 12, 50]) {
      expect(twoSidedPValue(-z)).toBe(twoSidedPValue(z));
      expect(twoSidedPValue(z)).toBeGreaterThanOrEqual(0);
      expect(twoSidedPValue(z)).toBeLessThanOrEqual(1);
    }
    expect(twoSidedPValue(50)).toBeLessThan(1e-6);
  });
});

describe("analyzeExperiment", () => {
  // Each case was computed independently in Python (pooled z-test, unpooled interval).
  it("10% vs 13% with 1,000 users each: treatment is better", () => {
    const a = analyzeExperiment({ users: 1000, conversions: 100 }, { users: 1000, conversions: 130 }, half);
    expect(a.control.rate).toBeCloseTo(0.1, 10);
    expect(a.treatment.rate).toBeCloseTo(0.13, 10);
    expect(a.absoluteLift).toBeCloseTo(0.03, 10);
    expect(a.relativeLift).toBeCloseTo(0.3, 10);
    expect(a.zScore).toBeCloseTo(2.102741, 5);
    expect(a.pValue).toBeCloseTo(0.035488, 5);
    expect(a.confidenceInterval!.low).toBeCloseTo(0.002068, 5);
    expect(a.confidenceInterval!.high).toBeCloseTo(0.057932, 5);
    expect(a.verdict).toBe("treatment_better");
  });

  it("10.0% vs 10.1% with 5,000 users each: no difference detected", () => {
    const a = analyzeExperiment({ users: 5000, conversions: 500 }, { users: 5000, conversions: 505 }, half);
    expect(a.zScore).toBeCloseTo(0.166298, 5);
    expect(a.pValue).toBeCloseTo(0.867923, 5);
    expect(a.verdict).toBe("no_difference_detected");
    // The interval straddles zero: the data are compatible with a small loss or a small gain.
    expect(a.confidenceInterval!.low).toBeLessThan(0);
    expect(a.confidenceInterval!.high).toBeGreaterThan(0);
  });

  it("15% vs 12% with 2,000 users each: treatment is worse", () => {
    const a = analyzeExperiment({ users: 2000, conversions: 300 }, { users: 2000, conversions: 240 }, half);
    expect(a.zScore).toBeCloseTo(-2.776172, 5);
    expect(a.pValue).toBeCloseTo(0.0055, 5);
    expect(a.relativeLift).toBeCloseTo(-0.2, 10);
    expect(a.confidenceInterval!.high).toBeLessThan(0);
    expect(a.verdict).toBe("treatment_worse");
  });

  it("works for an uneven rollout (10% treatment)", () => {
    const a = analyzeExperiment({ users: 9000, conversions: 900 }, { users: 1000, conversions: 120 }, { expectedTreatmentShare: 0.1 });
    expect(a.zScore).toBeCloseTo(1.982499, 5);
    expect(a.pValue).toBeCloseTo(0.047423, 5);
    expect(a.sampleRatio.observedTreatmentShare).toBeCloseTo(0.1, 10);
    expect(a.sampleRatio.mismatch).toBe(false);
  });

  it("the same rates are more convincing with more users", () => {
    const small = analyzeExperiment({ users: 200, conversions: 20 }, { users: 200, conversions: 26 }, half);
    const large = analyzeExperiment({ users: 20000, conversions: 2000 }, { users: 20000, conversions: 2600 }, half);
    expect(small.absoluteLift).toBeCloseTo(large.absoluteLift, 10);
    expect(small.verdict).toBe("no_difference_detected");
    expect(large.verdict).toBe("treatment_better");
    expect(large.pValue!).toBeLessThan(small.pValue!);
  });

  it("identical groups give z = 0 and p = 1", () => {
    const a = analyzeExperiment({ users: 1000, conversions: 100 }, { users: 1000, conversions: 100 }, half);
    expect(a.zScore).toBe(0);
    expect(a.pValue).toBeCloseTo(1, 6);
    expect(a.verdict).toBe("no_difference_detected");
  });

  it("respects a stricter significance level", () => {
    const counts = [{ users: 1000, conversions: 100 }, { users: 1000, conversions: 130 }] as const; // p = 0.035
    expect(analyzeExperiment(counts[0], counts[1], { ...half, alpha: 0.05 }).verdict).toBe("treatment_better");
    expect(analyzeExperiment(counts[0], counts[1], { ...half, alpha: 0.01 }).verdict).toBe("no_difference_detected");
  });
});

describe("refusing to conclude from too little", () => {
  it("gives no verdict and no p-value while a group is below the minimum", () => {
    const a = analyzeExperiment({ users: 99, conversions: 5 }, { users: 5000, conversions: 900 }, half);
    expect(a.verdict).toBe("not_enough_data");
    expect(a.zScore).toBeNull();
    expect(a.pValue).toBeNull();
    expect(a.confidenceInterval).toBeNull();
    // The plain rates are still reported: they are facts, just not a conclusion.
    expect(a.treatment.rate).toBeCloseTo(0.18, 10);
  });

  it("gives no verdict when conversions are too rare for the test to be valid", () => {
    // 1,000 users each but only 3 conversions in total: the normal approximation does not hold.
    expect(analyzeExperiment({ users: 1000, conversions: 1 }, { users: 1000, conversions: 2 }, half).verdict).toBe("not_enough_data");
    // The same applies when nearly everyone converts.
    expect(analyzeExperiment({ users: 1000, conversions: 999 }, { users: 1000, conversions: 998 }, half).verdict).toBe("not_enough_data");
  });

  it("handles empty groups without dividing by zero", () => {
    const a = analyzeExperiment({ users: 0, conversions: 0 }, { users: 0, conversions: 0 }, half);
    expect(a).toMatchObject({ verdict: "not_enough_data", absoluteLift: 0, relativeLift: null });
    expect(a.sampleRatio).toEqual({ expectedTreatmentShare: 0.5, observedTreatmentShare: null, pValue: null, mismatch: false });
    expect(Number.isNaN(a.control.rate)).toBe(false);
  });

  it("reports no relative lift when the control never converts", () => {
    const a = analyzeExperiment({ users: 500, conversions: 0 }, { users: 500, conversions: 40 }, half);
    expect(a.relativeLift).toBeNull();
    expect(a.absoluteLift).toBeCloseTo(0.08, 10);
    expect(a.verdict).toBe("treatment_better");
  });

  it("the minimum is adjustable", () => {
    const counts = [{ users: 60, conversions: 12 }, { users: 60, conversions: 30 }] as const;
    expect(analyzeExperiment(counts[0], counts[1], half).verdict).toBe("not_enough_data");
    expect(analyzeExperiment(counts[0], counts[1], { ...half, minUsersPerGroup: 50 }).verdict).toBe("treatment_better");
  });
});

describe("sample ratio check", () => {
  it("flags a split that does not match the rollout", () => {
    // The rollout says 50/50, but 1,200 users landed in control and 800 in treatment.
    const a = analyzeExperiment({ users: 1200, conversions: 100 }, { users: 800, conversions: 70 }, half);
    expect(a.sampleRatio.observedTreatmentShare).toBeCloseTo(0.4, 10);
    expect(a.sampleRatio.pValue!).toBeLessThan(0.001);
    expect(a.sampleRatio.mismatch).toBe(true);
  });

  it("accepts ordinary chance variation around the expected split", () => {
    const a = analyzeExperiment({ users: 5080, conversions: 500 }, { users: 4920, conversions: 500 }, half);
    expect(a.sampleRatio.mismatch).toBe(false);
    expect(a.sampleRatio.pValue!).toBeGreaterThan(0.05);
  });

  it("the same counts are fine for one rollout and a mismatch for another", () => {
    const control = { users: 9000, conversions: 900 };
    const treatment = { users: 1000, conversions: 100 };
    expect(analyzeExperiment(control, treatment, { expectedTreatmentShare: 0.1 }).sampleRatio.mismatch).toBe(false);
    expect(analyzeExperiment(control, treatment, { expectedTreatmentShare: 0.5 }).sampleRatio.mismatch).toBe(true);
  });

  it("does not cry mismatch over a handful of users", () => {
    const a = analyzeExperiment({ users: 9, conversions: 1 }, { users: 1, conversions: 0 }, half);
    expect(a.sampleRatio.mismatch).toBe(false);
    expect(a.sampleRatio.observedTreatmentShare).toBeCloseTo(0.1, 10);
  });
});

describe("input checks", () => {
  it("rejects impossible counts", () => {
    expect(() => analyzeExperiment({ users: 10, conversions: 11 }, { users: 10, conversions: 1 }, half)).toThrow(/more conversions than users/);
    expect(() => analyzeExperiment({ users: -1, conversions: 0 }, { users: 10, conversions: 1 }, half)).toThrow(RangeError);
    expect(() => analyzeExperiment({ users: 10.5, conversions: 1 }, { users: 10, conversions: 1 }, half)).toThrow(RangeError);
    expect(() => analyzeExperiment({ users: Number.NaN, conversions: 0 }, { users: 10, conversions: 1 }, half)).toThrow(RangeError);
  });

  it("rejects a rollout that leaves one group empty by design", () => {
    for (const share of [0, 1, -0.2, 1.5, Number.NaN]) {
      expect(() => analyzeExperiment({ users: 100, conversions: 1 }, { users: 100, conversions: 1 }, { expectedTreatmentShare: share })).toThrow(/both groups/);
    }
  });
});
