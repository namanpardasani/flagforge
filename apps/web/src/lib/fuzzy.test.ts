import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy";

const score = (item: string, typed: string) => fuzzyScore(item, typed);

describe("fuzzyScore", () => {
  it("finds a flag key from an abbreviation with skipped letters", () => {
    expect(score("flag route-optimizer-v2 Route optimizer v2", "rtopt")).toBeGreaterThan(0);
    expect(score("flag instant-payouts", "instpay")).toBeGreaterThan(0);
    expect(score("flag carrier-rate-cache", "crc")).toBeGreaterThan(0);
  });

  it("needs every typed word to match, each inside one word of the item", () => {
    expect(score("turn off instant-payouts kill disable stop", "kill pay")).toBeGreaterThan(0);
    expect(score("turn off instant-payouts kill disable stop", "kill zebra")).toBe(0);
  });

  it("does NOT build a match from letters scattered across a sentence", () => {
    // a..u..d..i..t all occur in order somewhere in this text, but never within one word.
    const description = "flag carrier-rate-cache Serve carrier quotes from cache for five minutes";
    expect(score(description, "audit")).toBe(0);
    expect(score("go Audit log", "audit")).toBeGreaterThan(0);
  });

  it("ranks: exact, then prefix, then start of a key part, then inside, then letters with gaps", () => {
    const exact = score("flags", "flags");
    const prefix = score("flags", "fla");
    const part = score("route-optimizer-v2", "opt");
    const inside = score("route-optimizer-v2", "timiz");
    const gaps = score("route-optimizer-v2", "rtopt");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(part);
    expect(part).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(gaps);
    expect(gaps).toBeGreaterThan(0);
  });

  it("prefers tight matches over spread-out ones", () => {
    expect(score("abcdef", "abc")).toBeGreaterThan(score("axbxcx", "abc"));
    expect(score("axbxcx", "abc")).toBeGreaterThan(score("axxxxbxxxxc", "abc"));
  });

  it("ignores case and extra spaces, and shows everything when nothing is typed", () => {
    expect(score("Audit Log", "  AUDIT  ")).toBeGreaterThan(0);
    expect(score("anything", "")).toBe(1);
    expect(score("anything", "   ")).toBe(1);
    expect(score("", "x")).toBe(0);
  });

  it("does not match on a single stray letter in the middle of a word", () => {
    expect(score("route", "z")).toBe(0);
    expect(score("route", "u")).toBeGreaterThan(0); // contained, so still a (weak) match
    expect(score("route", "r")).toBeGreaterThan(score("route", "u"));
  });

  it("never returns more than 1 or less than 0", () => {
    for (const [item, typed] of [["flags", "flags"], ["a b c", "a b c"], ["route-optimizer-v2", "rtopt"], ["x", "y"]] as const) {
      const s = score(item, typed);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
