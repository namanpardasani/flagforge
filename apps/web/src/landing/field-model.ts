import { bucketFor } from "@flagforge/core";

/**
 * The maths behind the hero dot field, kept free of canvas and React so it can be tested.
 *
 * Every dot is one pretend user, "user-0" to "user-N". Whether a dot is lit is decided by the SAME
 * function the SDK uses: bucketFor(flagKey, userKey) gives a fixed number from 0 to 9999, and the
 * user has the flag when that number is below the rollout cut-off. A user's number never changes,
 * which is why raising 20% to 30% lights only new dots and never turns one off.
 */

export const FIELD_FLAG = "hero-rollout";
/** Buckets per 1%: bucketFor returns 0 to 9999. */
const PER_PERCENT = 100;

export interface FieldLayout {
  cols: number;
  rows: number;
  /** Distance between dot centres, in CSS pixels. */
  pitch: number;
  /** Top-left dot centre, so the grid sits centred in the box. */
  originX: number;
  originY: number;
  count: number;
}

/** Fits a grid of roughly `target` dots into a box, keeping the cells square. */
export function layoutField(width: number, height: number, target: number): FieldLayout {
  if (width <= 0 || height <= 0) return { cols: 0, rows: 0, pitch: 0, originX: 0, originY: 0, count: 0 };
  const pitch = Math.sqrt((width * height) / target);
  const cols = Math.max(1, Math.floor(width / pitch));
  const rows = Math.max(1, Math.floor(height / pitch));
  return {
    cols,
    rows,
    pitch,
    originX: (width - (cols - 1) * pitch) / 2,
    originY: (height - (rows - 1) * pitch) / 2,
    count: cols * rows,
  };
}

/** One bucket per dot. Hashing happens once here, never per frame. */
export function fieldBuckets(count: number): Uint16Array {
  const buckets = new Uint16Array(count);
  for (let i = 0; i < count; i++) buckets[i] = bucketFor(FIELD_FLAG, `user-${i}`);
  return buckets;
}

export const isLit = (bucket: number, percentage: number) => bucket < percentage * PER_PERCENT;

export function countLit(buckets: Uint16Array, percentage: number): number {
  let lit = 0;
  for (const bucket of buckets) if (isLit(bucket, percentage)) lit++;
  return lit;
}

/**
 * How far the cursor pulls a dot, as a fraction of the distance (0 = not at all).
 * Strongest right next to the cursor, fading smoothly to nothing at `radius`.
 */
export function pull(distance: number, radius: number): number {
  if (distance >= radius) return 0;
  const closeness = 1 - distance / radius;
  return closeness * closeness;
}
