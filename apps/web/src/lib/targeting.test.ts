import { bucketFor } from "@flagforge/core";
import { describe, expect, it } from "vitest";
import { isIncluded, newRule, sameTargeting, SAMPLE_SIZE, sampleBuckets, validateRule } from "./targeting";

describe("rollout preview sample", () => {
  const keys = ["route-optimizer-v2", "instant-payouts", "x", "a-much-longer-flag-key.with_dots"];

  it("gives 100 users, exactly one in each 1% band of the bucket range", () => {
    for (const key of keys) {
      const buckets = sampleBuckets(key);
      expect(buckets).toHaveLength(SAMPLE_SIZE);
      expect(new Set(buckets.map((b) => Math.floor(b / 100))).size).toBe(SAMPLE_SIZE);
    }
  });

  it("lights exactly N squares at N percent, for every whole percentage", () => {
    for (const key of keys) {
      const buckets = sampleBuckets(key);
      for (let pct = 0; pct <= 100; pct++) expect(buckets.filter((b) => isIncluded(b, pct)).length).toBe(pct);
    }
  });

  it("only ever ADDS squares as the percentage rises (nobody flips back off)", () => {
    const buckets = sampleBuckets("route-optimizer-v2");
    let previous = new Set<number>();
    for (let pct = 0; pct <= 100; pct += 5) {
      const lit = new Set(buckets.map((b, i) => (isIncluded(b, pct) ? i : -1)).filter((i) => i >= 0));
      for (const index of previous) expect(lit.has(index)).toBe(true);
      previous = lit;
    }
  });

  it("uses the real bucketing function from @flagforge/core (not a stand-in)", () => {
    // Every bucket in the sample must be the real bucket of some sample user for this flag.
    const real = new Set(Array.from({ length: 5000 }, (_, i) => bucketFor("instant-payouts", `sample-user-${i + 1}`)));
    for (const bucket of sampleBuckets("instant-payouts")) expect(real.has(bucket)).toBe(true);
  });

  it("is scattered, not sorted (the grid should not fill like a progress bar)", () => {
    const buckets = sampleBuckets("route-optimizer-v2");
    expect(buckets).not.toEqual([...buckets].sort((a, b) => a - b));
  });

  it("is the same every time for the same flag, and different between flags", () => {
    expect(sampleBuckets("instant-payouts")).toEqual(sampleBuckets("instant-payouts"));
    expect(sampleBuckets("instant-payouts")).not.toEqual(sampleBuckets("route-optimizer-v2"));
  });
});

describe("rule validation", () => {
  const rule = (patch = {}) => ({ ...newRule(), attribute: "plan", value: "pro", ...patch });

  it("accepts a complete rule", () => {
    expect(validateRule(rule())).toBeNull();
    expect(validateRule(rule({ operator: "in", value: "OSL, BGO" }))).toBeNull();
    expect(validateRule(rule({ operator: "gte", value: "6" }))).toBeNull();
    expect(validateRule(rule({ rolloutPercentage: 0 }))).toBeNull();
  });

  it("explains what is missing or wrong", () => {
    expect(validateRule(rule({ attribute: "  " }))).toMatch(/attribute/);
    expect(validateRule(rule({ value: "" }))).toMatch(/value/);
    expect(validateRule(rule({ operator: "gt", value: "abc" }))).toMatch(/number/);
    expect(validateRule(rule({ operator: "in", value: " , , " }))).toMatch(/at least one/);
    expect(validateRule(rule({ rolloutPercentage: 101 }))).toMatch(/0 and 100/);
    expect(validateRule(rule({ rolloutPercentage: -1 }))).toMatch(/0 and 100/);
    expect(validateRule(rule({ rolloutPercentage: Number.NaN }))).toMatch(/0 and 100/);
  });

  it("new rules get unique ids", () => {
    expect(newRule().id).not.toBe(newRule().id);
  });

  it("compares targeting by content, including rule ORDER", () => {
    const a = rule({ id: "a" });
    const b = rule({ id: "b" });
    expect(sameTargeting({ rolloutPercentage: 10, rules: [a, b] }, { rolloutPercentage: 10, rules: [{ ...a }, { ...b }] })).toBe(true);
    expect(sameTargeting({ rolloutPercentage: 10, rules: [a, b] }, { rolloutPercentage: 10, rules: [b, a] })).toBe(false);
    expect(sameTargeting({ rolloutPercentage: 10, rules: [] }, { rolloutPercentage: 11, rules: [] })).toBe(false);
  });
});
