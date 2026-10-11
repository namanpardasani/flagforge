/** Small helpers shared by the benchmark scripts. */

/** The value below which `p` percent of the samples fall. `sorted` must be ascending. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export function summarize(samples: number[] | Float64Array) {
  const sorted = Float64Array.from(samples).sort();
  let sum = 0;
  for (const value of sorted) sum += value;
  return { count: sorted.length, mean: sum / sorted.length, min: sorted[0]!, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted[sorted.length - 1]! };
}

export const median = (values: number[]) => percentile(Float64Array.from(values).sort(), 50);

/** A repeatable pseudo-random generator (mulberry32): the same seed gives the same "random" users every run. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
