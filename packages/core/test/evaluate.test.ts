import { describe, expect, it } from "vitest";
import { bucketFor, evaluateFlag, type FlagConfig, type Rule } from "../src/index.js";

const flag = (overrides: Partial<FlagConfig> = {}): FlagConfig => ({
  key: "new-checkout",
  enabled: true,
  rules: [],
  fallthroughBps: 10000,
  ...overrides,
});
const rule = (id: string, attribute: string, value: string, rolloutBps = 10000): Rule => ({
  id,
  conditions: [{ attribute, operator: "equals", value }],
  rolloutBps,
});
const ctx = (key: string, attributes?: Record<string, any>) => ({ key, attributes });

describe("kill switch", () => {
  it("returns false with reason OFF when disabled, whatever the rules say", () => {
    const config = flag({ enabled: false, rules: [rule("r1", "plan", "pro")], fallthroughBps: 10000 });
    expect(evaluateFlag(config, ctx("u1", { plan: "pro" }))).toEqual({ value: false, reason: "OFF" });
  });
});

describe("fallthrough rollout", () => {
  it("serves everyone at 100% and no one at 0%", () => {
    for (let i = 0; i < 200; i++) {
      expect(evaluateFlag(flag({ fallthroughBps: 10000 }), ctx(`u${i}`))).toEqual({ value: true, reason: "FALLTHROUGH" });
      expect(evaluateFlag(flag({ fallthroughBps: 0 }), ctx(`u${i}`))).toEqual({ value: false, reason: "FALLTHROUGH" });
    }
  });

  it("uses the user's bucket: value is true exactly when bucket < bps", () => {
    for (let i = 0; i < 500; i++) {
      const userKey = `u${i}`;
      const expected = bucketFor("new-checkout", userKey) < 2500;
      expect(evaluateFlag(flag({ fallthroughBps: 2500 }), ctx(userKey)).value).toBe(expected);
    }
  });

  it("includes a user only when bucket < bps: the boundary is exclusive", () => {
    // bucketFor("new-checkout", "user-1") is 631 (pinned in hash.test.ts).
    const at = (bps: number) => evaluateFlag(flag({ fallthroughBps: bps }), ctx("user-1")).value;
    expect(at(630)).toBe(false);
    expect(at(631)).toBe(false); // bucket 631 is NOT inside a 631-bucket rollout (buckets 0..630)
    expect(at(632)).toBe(true);
    expect(at(1)).toBe(false);
  });

  it("applies the same exclusive boundary inside rules", () => {
    const config = (bps: number) => flag({ fallthroughBps: 0, rules: [rule("r", "plan", "pro", bps)] });
    const user = ctx("user-1", { plan: "pro" });
    expect(evaluateFlag(config(631), user).value).toBe(false);
    expect(evaluateFlag(config(632), user).value).toBe(true);
  });

  it("supports fractional percentages like 12.5% (1250 bps)", () => {
    let on = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) if (evaluateFlag(flag({ fallthroughBps: 1250 }), ctx(`u${i}`)).value) on++;
    expect(on / n).toBeGreaterThan(0.12);
    expect(on / n).toBeLessThan(0.13);
  });

  it("is deterministic: same user, same answer, every time", () => {
    const config = flag({ fallthroughBps: 5000 });
    for (let i = 0; i < 200; i++) {
      const first = evaluateFlag(config, ctx(`u${i}`));
      for (let j = 0; j < 3; j++) expect(evaluateFlag(config, ctx(`u${i}`))).toEqual(first);
    }
  });

  it("is monotonic: raising the percentage only adds users, never removes them", () => {
    const steps = [0, 500, 1250, 5000, 9000, 10000];
    let previous = new Set<string>();
    for (const bps of steps) {
      const current = new Set<string>();
      for (let i = 0; i < 5000; i++) {
        if (evaluateFlag(flag({ fallthroughBps: bps }), ctx(`u${i}`)).value) current.add(`u${i}`);
      }
      for (const user of previous) expect(current.has(user), `${user} dropped at ${bps}`).toBe(true);
      previous = current;
    }
  });
});

describe("rules", () => {
  it("applies the first matching rule and reports its id", () => {
    const config = flag({
      fallthroughBps: 0,
      rules: [rule("beta", "group", "beta"), rule("pro", "plan", "pro")],
    });
    expect(evaluateFlag(config, ctx("u1", { plan: "pro" }))).toEqual({ value: true, reason: "RULE_MATCH", ruleId: "pro" });
    expect(evaluateFlag(config, ctx("u1", { plan: "pro", group: "beta" }))).toMatchObject({ ruleId: "beta" });
  });

  it("falls through when no rule matches", () => {
    const config = flag({ fallthroughBps: 0, rules: [rule("pro", "plan", "pro")] });
    expect(evaluateFlag(config, ctx("u1", { plan: "free" }))).toEqual({ value: false, reason: "FALLTHROUGH" });
    expect(evaluateFlag(config, ctx("u1"))).toEqual({ value: false, reason: "FALLTHROUGH" });
  });

  it("requires ALL conditions of a rule to match", () => {
    const config = flag({
      fallthroughBps: 0,
      rules: [
        {
          id: "both",
          conditions: [
            { attribute: "plan", operator: "equals", value: "pro" },
            { attribute: "age", operator: "gte", value: 18 },
          ],
          rolloutBps: 10000,
        },
      ],
    });
    expect(evaluateFlag(config, ctx("u", { plan: "pro", age: 30 })).reason).toBe("RULE_MATCH");
    expect(evaluateFlag(config, ctx("u", { plan: "pro", age: 10 })).reason).toBe("FALLTHROUGH");
    expect(evaluateFlag(config, ctx("u", { plan: "free", age: 30 })).reason).toBe("FALLTHROUGH");
    expect(evaluateFlag(config, ctx("u", { plan: "pro" })).reason).toBe("FALLTHROUGH");
  });

  it("a matching rule with 0% explicitly denies, even if the fallthrough would allow", () => {
    const config = flag({ fallthroughBps: 10000, rules: [rule("blocked", "country", "XX", 0)] });
    expect(evaluateFlag(config, ctx("u1", { country: "XX" }))).toEqual({ value: false, reason: "RULE_MATCH", ruleId: "blocked" });
    expect(evaluateFlag(config, ctx("u1", { country: "US" }))).toEqual({ value: true, reason: "FALLTHROUGH" });
  });

  it("rolls out within a rule using the same bucket", () => {
    const config = flag({ fallthroughBps: 0, rules: [rule("us-half", "country", "US", 5000)] });
    for (let i = 0; i < 500; i++) {
      const userKey = `u${i}`;
      const result = evaluateFlag(config, ctx(userKey, { country: "US" }));
      expect(result.reason).toBe("RULE_MATCH");
      expect(result.value).toBe(bucketFor("new-checkout", userKey) < 5000);
    }
  });

  it("a rule with no conditions matches everyone (the API forbids creating one)", () => {
    const config = flag({ fallthroughBps: 0, rules: [{ id: "all", conditions: [], rolloutBps: 10000 }] });
    expect(evaluateFlag(config, ctx("u1")).reason).toBe("RULE_MATCH");
  });
});

describe("purity", () => {
  it("does not mutate its inputs", () => {
    const config = flag({ rules: [rule("r", "plan", "pro", 5000)], fallthroughBps: 2000 });
    const context = ctx("u1", { plan: "pro", tags: ["a"] });
    const before = JSON.stringify([config, context]);
    evaluateFlag(config, context);
    expect(JSON.stringify([config, context])).toBe(before);
  });
});
