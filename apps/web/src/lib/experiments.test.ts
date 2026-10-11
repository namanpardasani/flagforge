import { analyzeExperiment } from "@flagforge/core";
import { describe, expect, it } from "vitest";
import type { Experiment, ExperimentResults } from "@/api/types";
import { describeResult, percent, points, splitProblem } from "./experiments";

const experiment: Experiment = {
  id: "x", projectId: "p", name: "One-tap", hypothesis: "", metricKey: "paid", status: "RUNNING", flagId: "f", flagKey: "one-tap-checkout", flagName: "One-tap",
  environmentId: "e", environmentKey: "prod", environmentName: "Production", startedAt: null, stoppedAt: null, createdAt: "",
};
const make = (control: { users: number; conversions: number }, treatment: { users: number; conversions: number }, share = 0.5): ExperimentResults => ({
  experiment,
  flagState: { enabled: true, rolloutPercentage: share * 100, ruleCount: 0 },
  groups: { control, treatment },
  analysis: control.users + treatment.users === 0 ? null : analyzeExperiment(control, treatment, { expectedTreatmentShare: share }),
  sampleRatioChecked: true,
});

describe("formatting", () => {
  it("shows rates as percentages and differences as signed points", () => {
    expect(percent(0.1234)).toBe("12.3%");
    expect(points(0.03)).toBe("+3.0 points");
    expect(points(-0.052)).toBe("-5.2 points");
    expect(points(0)).toBe("0.0 points");
    expect(points(0.01)).toBe("+1.0 point");
    expect(points(0.00001)).toBe("0.0 points"); // no "+0.0"
  });
});

describe("describeResult", () => {
  it("explains an empty experiment by what to check, not with zeros", () => {
    const text = describeResult(make({ users: 0, conversions: 0 }, { users: 0, conversions: 0 }));
    expect(text.tone).toBe("waiting");
    expect(text.detail).toMatch(/sendEvents/);
    expect(text.detail).toMatch(/isEnabled/);
  });

  it("says how many more users are needed instead of guessing", () => {
    const text = describeResult(make({ users: 40, conversions: 3 }, { users: 90, conversions: 12 }));
    expect(text).toMatchObject({ tone: "waiting", headline: "Not enough data yet" });
    expect(text.detail).toContain("40 without the flag, 90 with it");
    expect(text.detail).toContain("at least 60 more users");
  });

  it("with enough users but too few conversions, says that instead", () => {
    const text = describeResult(make({ users: 1000, conversions: 1 }, { users: 1000, conversions: 2 }));
    expect(text.tone).toBe("waiting");
    expect(text.detail).toContain("too few conversions");
    expect(text.detail).not.toContain("more users needed");
  });

  it("a better result states the rates, the lift, the interval and the chance level", () => {
    const text = describeResult(make({ users: 1000, conversions: 100 }, { users: 1000, conversions: 130 }));
    expect(text).toMatchObject({ tone: "better", headline: "Users with the flag convert more" });
    expect(text.detail).toContain("13.0% against 10.0%");
    expect(text.detail).toContain("+3.0 points");
    expect(text.detail).toContain("+30% relative");
    expect(text.detail).toContain("95% confidence interval +0.2 points to +5.8 points");
    expect(text.detail).toContain("about 3.5% of the time");
  });

  it("a worse result says so plainly", () => {
    const text = describeResult(make({ users: 2000, conversions: 300 }, { users: 2000, conversions: 240 }));
    expect(text).toMatchObject({ tone: "worse", headline: "Users with the flag convert less" });
    expect(text.detail).toContain("-3.0 points");
    expect(text.detail).toContain("-20% relative");
    expect(text.detail).toContain("about 0.6% of the time");
  });

  it("'no difference' never claims there is no effect", () => {
    const text = describeResult(make({ users: 5000, conversions: 500 }, { users: 5000, conversions: 505 }));
    expect(text).toMatchObject({ tone: "neutral", headline: "No difference detected" });
    expect(text.detail).toContain("does not prove the flag has no effect");
    expect(text.headline.toLowerCase()).not.toContain("no effect");
  });

  it("very small p-values are not printed as false precision", () => {
    const text = describeResult(make({ users: 20000, conversions: 2000 }, { users: 20000, conversions: 2600 }));
    expect(text.detail).toContain("less than 1 time in 1,000");
  });
});

describe("splitProblem", () => {
  it("is null for a healthy split", () => {
    expect(splitProblem(make({ users: 500, conversions: 50 }, { users: 500, conversions: 60 }))).toBeNull();
  });

  it("explains a mismatch with both numbers and what to do", () => {
    const text = splitProblem(make({ users: 1200, conversions: 100 }, { users: 800, conversions: 70 }))!;
    expect(text).toContain("sends 50.0% of users to the flag");
    expect(text).toContain("40.0% of the users recorded had it");
    expect(text).toContain("do not trust these results");
  });

  it("is null when there is no analysis", () => {
    expect(splitProblem(make({ users: 0, conversions: 0 }, { users: 0, conversions: 0 }))).toBeNull();
  });
});
