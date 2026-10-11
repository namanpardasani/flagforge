// MEASUREMENT 3 (k6): load on the SDK config endpoint, GET /sdk/v1/flags.
//
//   pnpm bench:server                 (terminal 1: local server, rate limits off, Redis on)
//   pnpm bench:load                   (terminal 2)        or:  k6 run loadtest/sdk-config.js
//
// LOCAL ONLY. Never point this at Neon, Upstash, Render or any hosted service.
//
// It raises the request rate in steps and holds each step, so the summary shows latency PER STEP.
// The step where p95 jumps (or where k6 starts dropping iterations because the server cannot keep
// up) is the degradation point; the last step before it is the "stable load" to report.
//
// Two request shapes, because both are real:
//   full   : no If-None-Match, the server sends the whole config (what an SDK does at start-up)
//   poll   : If-None-Match with the current ETag, the server answers 304 with no body (what every
//            SDK does on every poll afterwards). MODE=poll selects it. Default: full.
import { check } from "k6";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3070";
const MODE = __ENV.MODE || "full";
const HOLD = __ENV.HOLD || "30s";
const RATES = (__ENV.RATES || "100,250,500,1000,1500,2000,3000,4000").split(",").map(Number);
const FLAGS = Number(__ENV.FLAGS || 20);

const holdSeconds = Number(HOLD.replace("s", ""));
const RAMP = 5; // seconds to move from one rate to the next

// One pair of stages per rate: move to it, then hold it.
const stages = [];
for (const rate of RATES) {
  stages.push({ target: rate, duration: `${RAMP}s` });
  stages.push({ target: rate, duration: HOLD });
}

export const options = {
  scenarios: {
    steps: {
      executor: "ramping-arrival-rate", // sends at the stated rate whatever the response time
      startRate: RATES[0],
      timeUnit: "1s",
      stages,
      preAllocatedVUs: 200,
      maxVUs: 4000,
    },
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  // No pass/fail thresholds: this run is for finding the limit, not for enforcing one.
};

// One latency metric and one error-rate metric per step, so each rate gets its own line.
const latency = {};
const errors = {};
const sent = {};
for (const rate of RATES) {
  latency[rate] = new Trend(`step_${String(rate).padStart(5, "0")}rps_ms`, true);
  errors[rate] = new Rate(`step_${String(rate).padStart(5, "0")}rps_errors`);
  sent[rate] = new Counter(`step_${String(rate).padStart(5, "0")}rps_requests`);
}

/** Which step is running now, from the time since the test started. Null while moving between steps. */
function currentStep(startedAt) {
  const elapsed = (Date.now() - startedAt) / 1000;
  const index = Math.floor(elapsed / (RAMP + holdSeconds));
  const within = elapsed - index * (RAMP + holdSeconds);
  return within < RAMP || index >= RATES.length ? null : RATES[index];
}

const json = { "Content-Type": "application/json" };

export function setup() {
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const post = (path, body, token) => http.post(`${BASE}${path}`, JSON.stringify(body), { headers: token ? { ...json, Authorization: `Bearer ${token}` } : json });
  const reg = post("/auth/register", { email: `k6-${tag}@flagforge.local`, password: `k6-${tag}-not-a-real-account`, name: "k6" });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.body}`);
  const token = reg.json("accessToken");
  const ws = post("/workspaces", { name: `k6 ${tag}`, slug: `k6-${tag}` }, token).json();
  const project = post(`/workspaces/${ws.id}/projects`, { name: "k6", key: "k6" }, token).json();
  const env = project.environments.find((e) => e.key === "prod");
  const flagsPath = `/workspaces/${ws.id}/projects/${project.id}/flags`;
  for (let i = 0; i < FLAGS; i++) {
    const flag = post(flagsPath, { key: `k6-flag-${i}`, name: `k6 flag ${i}` }, token).json();
    const state = i % 3 === 0 ? { enabled: false } : i % 3 === 1 ? { enabled: true, rolloutPercentage: 50 } : { enabled: true, rolloutPercentage: 10, rules: [{ conditions: [{ attribute: "plan", operator: "equals", value: "pro" }], rolloutPercentage: 100 }] };
    http.put(`${BASE}${flagsPath}/${flag.id}/environments/${env.id}`, JSON.stringify(state), { headers: { ...json, Authorization: `Bearer ${token}` } });
  }
  const apiKey = post(`/workspaces/${ws.id}/projects/${project.id}/environments/${env.id}/api-keys`, { name: "k6" }, token).json("key");
  const first = http.get(`${BASE}/sdk/v1/flags`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (first.status !== 200) throw new Error(`could not read flags with the new key: ${first.status}`);
  const health = http.get(`${BASE}/health`).json();
  console.log(`server health: ${JSON.stringify(health)}  mode: ${MODE}  rates: ${RATES.join(",")} rps  hold: ${HOLD}  response bytes: ${first.body.length}`);
  return { apiKey, etag: first.headers["Etag"], startedAt: Date.now() };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.apiKey}` };
  const expected = MODE === "poll" ? 304 : 200;
  if (MODE === "poll") headers["If-None-Match"] = data.etag;
  const res = http.get(`${BASE}/sdk/v1/flags`, { headers, responseCallback: http.expectedStatuses(expected) });
  const ok = check(res, { "expected status": (r) => r.status === expected });
  const step = currentStep(data.startedAt);
  if (step !== null) {
    latency[step].add(res.timings.duration);
    errors[step].add(!ok);
    sent[step].add(1);
  }
}
