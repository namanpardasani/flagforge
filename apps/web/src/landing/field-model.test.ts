import { describe, expect, it } from "vitest";
import { countLit, fieldBuckets, isLit, layoutField, pull } from "./field-model";

describe("field layout", () => {
  it("fits about the requested number of dots inside the box", () => {
    const layout = layoutField(1100, 440, 1200);
    expect(layout.count).toBe(layout.cols * layout.rows);
    expect(layout.count).toBeGreaterThan(1050);
    expect(layout.count).toBeLessThanOrEqual(1200);
    // First and last dot centres are inside the box, with the same margin on both sides.
    const lastX = layout.originX + (layout.cols - 1) * layout.pitch;
    const lastY = layout.originY + (layout.rows - 1) * layout.pitch;
    expect(layout.originX).toBeGreaterThan(0);
    expect(lastX).toBeCloseTo(1100 - layout.originX);
    expect(lastY).toBeCloseTo(440 - layout.originY);
  });

  it("returns an empty grid for a box with no size", () => {
    expect(layoutField(0, 300, 1200).count).toBe(0);
  });
});

describe("who is lit", () => {
  const buckets = fieldBuckets(1200);

  it("gives the same user the same bucket every time", () => {
    expect([...fieldBuckets(1200)]).toEqual([...buckets]);
  });

  it("raising 20% to 30% only ADDS users: nobody who had the flag loses it", () => {
    const at20 = [...buckets].map((bucket) => isLit(bucket, 20));
    const at30 = [...buckets].map((bucket) => isLit(bucket, 30));
    expect(at20.every((lit, i) => !lit || at30[i])).toBe(true);
    expect(countLit(buckets, 30)).toBeGreaterThan(countLit(buckets, 20));
  });

  it("lights nobody at 0% and everybody at 100%", () => {
    expect(countLit(buckets, 0)).toBe(0);
    expect(countLit(buckets, 100)).toBe(1200);
  });

  it("lights roughly the requested share", () => {
    for (const percentage of [5, 20, 50, 80]) {
      const share = (countLit(buckets, percentage) / 1200) * 100;
      expect(Math.abs(share - percentage)).toBeLessThan(4);
    }
  });
});

describe("cursor pull", () => {
  it("is strongest at the cursor, fades with distance and is zero at the edge of its reach", () => {
    expect(pull(0, 100)).toBe(1);
    expect(pull(50, 100)).toBeLessThan(pull(10, 100));
    expect(pull(100, 100)).toBe(0);
    expect(pull(400, 100)).toBe(0);
  });
});
