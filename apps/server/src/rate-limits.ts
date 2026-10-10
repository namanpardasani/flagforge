import type { RateRule } from "./redis/rate-limit.js";

export interface RateLimits {
  /** Whole management API, per client IP. (/sdk and /health are exempt: SDK fleets share one IP.) */
  global: RateRule;
  /** Unauthenticated floods on /sdk (e.g. guessing keys), per client IP. Generous: a fleet may sit behind one NAT. */
  sdkPerIp: RateRule;
  register: RateRule;
  /** Password guessing against ONE account from ONE address. */
  login: RateRule;
  /** Password guessing from one address across many accounts. */
  loginPerIp: RateRule;
  refresh: RateRule;
  sdkFlags: RateRule;
  sdkEvaluate: RateRule;
  /** Opening new streams (existing streams are limited separately by the connection caps). */
  sdkStream: RateRule;
}

const minute = 60_000;

/** Token buckets: `capacity` requests per `windowMs`, bursts allowed up to capacity. */
export const defaultLimits: RateLimits = {
  global: { capacity: 600, windowMs: minute },
  sdkPerIp: { capacity: 3000, windowMs: minute },
  register: { capacity: 10, windowMs: 60 * minute },
  login: { capacity: 5, windowMs: 15 * minute }, // 5 quick tries, then one more every 3 minutes
  loginPerIp: { capacity: 30, windowMs: 15 * minute },
  refresh: { capacity: 60, windowMs: minute },
  sdkFlags: { capacity: 1200, windowMs: minute },
  sdkEvaluate: { capacity: 6000, windowMs: minute },
  sdkStream: { capacity: 60, windowMs: minute },
};
