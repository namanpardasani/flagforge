import { BUCKET_COUNT } from "./types.js";

/**
 * MurmurHash3 (x86, 32-bit). A fast, well-distributed, NON-cryptographic hash.
 * Pure JS on purpose (no node:crypto) so the exact same code runs in Node and in browsers.
 */
export function murmur3(input: string, seed = 0): number {
  const data = new TextEncoder().encode(input);
  const len = data.length;
  const blocks = len >> 2;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;

  for (let i = 0; i < blocks; i++) {
    const o = i * 4;
    let k = data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16) | (data[o + 3]! << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  const tail = blocks * 4;
  const rest = len & 3;
  if (rest > 0) {
    let k = 0;
    if (rest === 3) k ^= data[tail + 2]! << 16;
    if (rest >= 2) k ^= data[tail + 1]! << 8;
    k ^= data[tail]!;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }

  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The user's bucket (0..9999) for one flag. The same user always lands in the same bucket for the
 * same flag, so raising a rollout from 10% to 20% only ADDS users and never flips anyone back off.
 * The flag key is part of the hash so different flags split users differently.
 * ":" separates the parts; flag keys cannot contain it, so ("ab","c") and ("a","bc") never collide.
 */
export function bucketFor(flagKey: string, userKey: string): number {
  return murmur3(`${flagKey}:${userKey}`) % BUCKET_COUNT;
}
