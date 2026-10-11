// MEASUREMENT 1: how long one local flag evaluation takes.
//
//   pnpm bench:eval
//
// What is timed: `evaluateFlag` from packages/core, the function the server and the SDK share, and
// the same call through the SDK client (`client.evaluate`). No network, no database: this is the
// cost of a flag check inside an application that uses the SDK.
//
// How it is timed, and why two ways:
//  - "batch": one timer around all 1,000,000 calls. Almost no measuring overhead, so this is the
//    honest MEAN. It cannot give percentiles.
//  - "per call": a timer around every call, for p50/p95/p99. Reading the clock twice costs about as
//    much as the evaluation itself, so these numbers include that cost. It is measured separately
//    and printed ("timer overhead") rather than subtracted, because subtracting an estimate would
//    make the result look more precise than it is.
import { evaluateFlag, type EvaluationContext, type FlagConfig } from "@flagforge/core";
import { FlagForgeClient } from "@flagforge/sdk";
import { environment } from "./env.ts";
import { median, seeded, summarize } from "./stats.ts";

const EVALUATIONS = 1_000_000;
const WARM_UP = 200_000;
const RUNS = 5;
const DISTINCT_USERS = 200_000; // cycled 5 times: a million objects would mostly measure memory

/** A realistic flag: five targeting rules of different kinds, then a 20% rollout for everyone else. */
const FLAG: FlagConfig = {
  key: "one-tap-checkout",
  enabled: true,
  rules: [
    { id: "enterprise", conditions: [{ attribute: "plan", operator: "in", value: ["enterprise", "partner"] }], rolloutBps: 10000 },
    { id: "nordic-loyal", conditions: [{ attribute: "country", operator: "in", value: ["NO", "SE", "DK", "FI"] }, { attribute: "tenureMonths", operator: "gte", value: 12 }], rolloutBps: 5000 },
    { id: "staff", conditions: [{ attribute: "email", operator: "ends_with", value: "@halden.example" }], rolloutBps: 10000 },
    { id: "app-v4-paying", conditions: [{ attribute: "appVersion", operator: "starts_with", value: "4." }, { attribute: "plan", operator: "not_equals", value: "free" }], rolloutBps: 2500 },
    { id: "pilot-depots", conditions: [{ attribute: "depot", operator: "in", value: ["OSL", "BGO", "TRD"] }], rolloutBps: 1000 },
  ],
  fallthroughBps: 2000,
};

function makeUsers(): EvaluationContext[] {
  const random = seeded(20261011);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const plans = ["free", "free", "free", "pro", "pro", "team", "enterprise"] as const;
  const countries = ["NO", "SE", "DK", "FI", "DE", "PL", "GB", "US", "IN", "JP"] as const;
  const depots = ["OSL", "BGO", "TRD", "STO", "CPH", "HEL", "BER", "WAW"] as const;
  const users: EvaluationContext[] = [];
  for (let i = 0; i < DISTINCT_USERS; i++) {
    users.push({
      key: `user-${i}-${Math.floor(random() * 1e9).toString(36)}`,
      attributes: {
        plan: pick(plans),
        country: pick(countries),
        depot: pick(depots),
        tenureMonths: Math.floor(random() * 60),
        appVersion: `${3 + Math.floor(random() * 3)}.${Math.floor(random() * 20)}.0`,
        email: random() < 0.02 ? `person${i}@halden.example` : `person${i}@mail.example`,
      },
    });
  }
  return users;
}

const users = makeUsers();
const gc = (globalThis as { gc?: () => void }).gc;

/** One run: warm up, then the batch timing, then the per-call timing. Times in microseconds. */
function run(evaluate: (user: EvaluationContext) => { value: boolean; reason: string }) {
  let sink = 0; // the results are used, so the engine cannot optimise the work away
  for (let i = 0; i < WARM_UP; i++) sink += evaluate(users[i % DISTINCT_USERS]!).value ? 1 : 0;
  gc?.();

  const batchStart = process.hrtime.bigint();
  for (let i = 0; i < EVALUATIONS; i++) sink += evaluate(users[i % DISTINCT_USERS]!).value ? 1 : 0;
  const batchMeanUs = Number(process.hrtime.bigint() - batchStart) / 1000 / EVALUATIONS;
  gc?.();

  const samples = new Float64Array(EVALUATIONS);
  for (let i = 0; i < EVALUATIONS; i++) {
    const user = users[i % DISTINCT_USERS]!;
    const start = performance.now();
    const result = evaluate(user);
    samples[i] = (performance.now() - start) * 1000;
    sink += result.value ? 1 : 0;
  }
  return { batchMeanUs, perCall: summarize(samples), sink };
}

/** What two clock reads cost with nothing in between: the floor under every per-call number. */
function timerOverheadUs() {
  const samples = new Float64Array(EVALUATIONS);
  for (let i = 0; i < EVALUATIONS; i++) {
    const start = performance.now();
    samples[i] = (performance.now() - start) * 1000;
  }
  return summarize(samples);
}

const us = (n: number) => n.toFixed(3);

function report(name: string, evaluate: (user: EvaluationContext) => { value: boolean; reason: string }) {
  console.log(`\n## ${name}: ${RUNS} runs of ${EVALUATIONS.toLocaleString("en")} evaluations (after ${WARM_UP.toLocaleString("en")} warm-up calls each)\n`);
  console.log("run | batch mean us | per-call mean | p50    | p95    | p99    | max us");
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = run(evaluate);
    runs.push(r);
    console.log(`${String(i).padStart(3)} | ${us(r.batchMeanUs).padStart(13)} | ${us(r.perCall.mean).padStart(13)} | ${us(r.perCall.p50).padStart(6)} | ${us(r.perCall.p95).padStart(6)} | ${us(r.perCall.p99).padStart(6)} | ${us(r.perCall.max).padStart(6)}`);
  }
  // The "median run" is the run whose batch mean is the middle one of the five.
  const middle = median(runs.map((r) => r.batchMeanUs));
  const chosen = runs.find((r) => r.batchMeanUs === middle)!;
  console.log(`\nmedian run (by batch mean): batch mean ${us(chosen.batchMeanUs)} us = ${Math.round(1 / (chosen.batchMeanUs / 1e6)).toLocaleString("en")} evaluations/second on one core`);
  console.log(`  per-call (includes timer overhead): mean ${us(chosen.perCall.mean)} us, p50 ${us(chosen.perCall.p50)} us, p95 ${us(chosen.perCall.p95)} us, p99 ${us(chosen.perCall.p99)} us`);
  return chosen;
}

console.log("# Local evaluation speed\n");
console.log("environment:", JSON.stringify(environment(), null, 2));
console.log(`\ngarbage collection between phases: ${gc ? "forced (node --expose-gc)" : "not forced"}`);

// Proof that real work is being done: how the 200,000 users are decided.
const outcome = { true: 0, false: 0 } as Record<string, number>;
const reasons: Record<string, number> = {};
for (const user of users) {
  const result = evaluateFlag(FLAG, user);
  outcome[String(result.value)]!++;
  const reason = result.reason === "RULE_MATCH" ? `RULE_MATCH:${result.ruleId}` : result.reason;
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}
console.log(`\nruleset: ${FLAG.rules.length} rules (${FLAG.rules.reduce((n, r) => n + r.conditions.length, 0)} conditions), fallthrough rollout ${FLAG.fallthroughBps / 100}%`);
console.log(`decisions over ${DISTINCT_USERS.toLocaleString("en")} distinct users: on=${outcome["true"]} off=${outcome["false"]}`);
console.log("by reason:", JSON.stringify(reasons));

const overhead = timerOverheadUs();
console.log(`\ntimer overhead (two clock reads, nothing between): mean ${us(overhead.mean)} us, p50 ${us(overhead.p50)} us, p95 ${us(overhead.p95)} us, p99 ${us(overhead.p99)} us`);

const core = report("packages/core evaluateFlag", (user) => evaluateFlag(FLAG, user));

// The same evaluation through the SDK client, as an application would call it. The client is
// started from a bootstrap config with the network pointed at a closed port, so nothing is fetched.
const client = new FlagForgeClient({
  apiKey: "ff_benchmark_key_0123456789abcdef",
  baseUrl: "http://127.0.0.1:9",
  streaming: false,
  pollIntervalMs: 0,
  requestTimeoutMs: 200,
  bootstrap: { environment: { id: "bench", key: "bench" }, version: 1, flags: [FLAG] },
});
client.on("error", () => {}); // the failed fetch is expected
const started = await client.init();
if (!started.ready) throw new Error("SDK client did not start from bootstrap");
const sdk = report("SDK client.evaluate (same flag, from memory)", (user) => client.evaluate(FLAG.key, user));
client.close();

console.log("\n## Summary (median runs)\n");
console.log(JSON.stringify({ evaluations: EVALUATIONS, runs: RUNS, distinctUsers: DISTINCT_USERS, timerOverheadUs: overhead, core, sdk }, null, 2));
