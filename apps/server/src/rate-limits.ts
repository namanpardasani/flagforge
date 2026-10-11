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
  /** Opening the emailed "confirm" link, per IP (guessing tokens is hopeless, but cheap lookups still deserve a cap). */
  verifyEmail: RateRule;
  /** Asking for another confirmation email, per signed-in user. Each one sends a real email. */
  resendVerification: RateRule;
  /** Asking for a password-reset email, per IP, across all addresses. */
  forgotPassword: RateRule;
  /** ...and per address, so one person's inbox cannot be flooded from many IPs. */
  forgotPasswordPerEmail: RateRule;
  /** Using a reset link to set a password, per IP. */
  resetPassword: RateRule;
  /** Opening new streams (existing streams are limited separately by the connection caps). */
  sdkStream: RateRule;
  /** Batches of experiment events, per key. Each batch may carry up to 500 events. */
  sdkEvents: RateRule;
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
  verifyEmail: { capacity: 20, windowMs: 15 * minute },
  resendVerification: { capacity: 3, windowMs: 60 * minute },
  forgotPassword: { capacity: 5, windowMs: 60 * minute },
  forgotPasswordPerEmail: { capacity: 3, windowMs: 60 * minute },
  resetPassword: { capacity: 10, windowMs: 15 * minute },
  sdkStream: { capacity: 60, windowMs: minute },
  sdkEvents: { capacity: 600, windowMs: minute },
};
