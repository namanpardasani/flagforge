import { describe, expect, it } from "vitest";
import { bucketFor, murmur3 } from "../src/index.js";

describe("murmur3", () => {
  it("matches the published MurmurHash3_x86_32 test vectors", () => {
    expect(murmur3("")).toBe(0x0);
    expect(murmur3("hello")).toBe(0x248bfa47);
    expect(murmur3("The quick brown fox jumps over the lazy dog")).toBe(0x2e4ff723);
  });

  it("handles every tail length (0-3 leftover bytes)", () => {
    // Expected values come from an independent Python reference implementation.
    expect(murmur3("a")).toBe(1009084850);
    expect(murmur3("ab")).toBe(2613040991);
    expect(murmur3("abc")).toBe(3017643002);
    expect(murmur3("abcd")).toBe(1139631978);
  });

  it("returns an unsigned 32-bit integer", () => {
    for (const s of ["", "x", "user-1", "héllo", "😀"]) {
      const h = murmur3(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("bucketFor", () => {
  it("is stable: these exact buckets must never change (changing them would reshuffle every user)", () => {
    expect(bucketFor("new-checkout", "user-1")).toBe(631);
    expect(bucketFor("new-checkout", "user-2")).toBe(789);
    expect(bucketFor("dark-mode", "user-1")).toBe(6475);
    expect(bucketFor("x", "héllo-ü😀")).toBe(1483);
  });

  it("is deterministic and always within 0..9999", () => {
    for (let i = 0; i < 2000; i++) {
      const b = bucketFor("flag", `user-${i}`);
      expect(b).toBe(bucketFor("flag", `user-${i}`));
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(10000);
    }
  });

  it("splits users roughly evenly (a 10% rollout reaches about 10% of 100,000 users)", () => {
    let inside = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) if (bucketFor("rollout-flag", `u${i}`) < 1000) inside++;
    expect(inside / n).toBeGreaterThan(0.095);
    expect(inside / n).toBeLessThan(0.105);
  });

  it("buckets different flags independently for the same users", () => {
    // If two flags shared buckets, the same 10% of users would always be the guinea pigs.
    let both = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      if (bucketFor("flag-a", `u${i}`) < 1000 && bucketFor("flag-b", `u${i}`) < 1000) both++;
    }
    // Independent 10% x 10% should be about 1%, not 10%.
    expect(both / n).toBeGreaterThan(0.007);
    expect(both / n).toBeLessThan(0.013);
  });

  it("does not collide when the flag/user boundary shifts", () => {
    expect(bucketFor("ab", "c")).not.toBe(bucketFor("a", "bc"));
  });
});
