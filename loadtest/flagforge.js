// k6 load test for the three hot paths of FlagForge. Run it against a LOCAL server only:
//
//   k6 run loadtest/flagforge.js
//   k6 run -e RATE=500 -e DURATION=30s loadtest/flagforge.js
//
// The server must be started with RATE_LIMIT_ENABLED=false, or the test measures the rate limiter.
// See loadtest/README.md.
import { check } from "k6";
import http from "k6/http";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const RATE = Number(__ENV.RATE || 200); // requests per second, per scenario
const DURATION = __ENV.DURATION || "20s";
const FLAGS = Number(__ENV.FLAGS || 20);

// Each scenario runs alone, one after the other, so their numbers do not blur into each other.
// "constant-arrival-rate" sends a fixed number of requests per second whatever the response time,
// which is how real clients behave (they do not slow down because the server did).
const seconds = (text) => Number(String(text).replace("s", ""));
const scenario = (exec, index) => ({
  executor: "constant-arrival-rate",
  exec,
  rate: RATE,
  timeUnit: "1s",
  duration: DURATION,
  startTime: `${index * (seconds(DURATION) + 3)}s`,
  preAllocatedVUs: Math.max(20, Math.ceil(RATE / 10)),
  maxVUs: Math.max(100, RATE),
  tags: { path: exec },
});

export const options = {
  scenarios: {
    sdk_poll: scenario("sdkPoll", 0),
    sdk_evaluate: scenario("sdkEvaluate", 1),
    dashboard_read: scenario("dashboardRead", 2),
  },
  thresholds: {
    // The run FAILS if these are not met. They are budgets for one local machine, not promises.
    "http_req_failed": ["rate<0.01"],
    "http_req_duration{path:sdkPoll}": ["p(95)<50"],
    "http_req_duration{path:sdkEvaluate}": ["p(95)<50"],
    "http_req_duration{path:dashboardRead}": ["p(95)<150"],
    "dropped_iterations": ["count<1"], // k6 could not keep up the requested rate
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const json = { "Content-Type": "application/json" };
const post = (path, body, token) => http.post(`${BASE}${path}`, JSON.stringify(body), { headers: token ? { ...json, Authorization: `Bearer ${token}` } : json, tags: { path: "setup" } });

/** Runs once: builds a workspace with flags and an API key through the public API. */
export function setup() {
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const reg = post("/auth/register", { email: `load-${tag}@flagforge.local`, password: `load-test-${tag}-not-a-real-account`, name: "Load test" });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.body}`);
  const token = reg.json("accessToken");

  const ws = post("/workspaces", { name: `Load ${tag}`, slug: `load-${tag}` }, token).json();
  const project = post(`/workspaces/${ws.id}/projects`, { name: "Load", key: "load" }, token).json();
  const env = project.environments.find((e) => e.key === "prod");
  const flagsPath = `/workspaces/${ws.id}/projects/${project.id}/flags`;

  const flagKeys = [];
  for (let i = 0; i < FLAGS; i++) {
    const key = `load-flag-${i}`;
    const flag = post(flagsPath, { key, name: `Load flag ${i}` }, token).json();
    // A mix: a third off, a third on a rollout, a third with a targeting rule.
    const state =
      i % 3 === 0 ? { enabled: false } : i % 3 === 1 ? { enabled: true, rolloutPercentage: 50 } : { enabled: true, rolloutPercentage: 10, rules: [{ conditions: [{ attribute: "plan", operator: "equals", value: "pro" }], rolloutPercentage: 100 }] };
    http.put(`${BASE}${flagsPath}/${flag.id}/environments/${env.id}`, JSON.stringify(state), { headers: { ...json, Authorization: `Bearer ${token}` }, tags: { path: "setup" } });
    flagKeys.push(key);
  }
  const apiKey = post(`/workspaces/${ws.id}/projects/${project.id}/environments/${env.id}/api-keys`, { name: "load test" }, token).json("key");

  const first = http.get(`${BASE}/sdk/v1/flags`, { headers: { Authorization: `Bearer ${apiKey}` }, tags: { path: "setup" } });
  if (first.status !== 200) throw new Error(`could not read flags with the new key: ${first.status}`);
  return { token, apiKey, flagKeys, flagsPath, etag: first.headers["Etag"] };
}

/** What an idle SDK does every poll: "has anything changed?" Normally the answer is 304, no body. */
export function sdkPoll(data) {
  const res = http.get(`${BASE}/sdk/v1/flags`, { headers: { Authorization: `Bearer ${data.apiKey}`, "If-None-Match": data.etag }, responseCallback: http.expectedStatuses(304) });
  check(res, { "poll is 304": (r) => r.status === 304 });
}

/** Server-side evaluation for clients that cannot run the SDK. */
export function sdkEvaluate(data) {
  const flagKey = data.flagKeys[Math.floor(Math.random() * data.flagKeys.length)];
  const user = Math.floor(Math.random() * 100000);
  const res = http.post(`${BASE}/sdk/v1/evaluate`, JSON.stringify({ flagKey, context: { key: `user-${user}`, attributes: { plan: user % 4 === 0 ? "pro" : "free" } } }), {
    headers: { ...json, Authorization: `Bearer ${data.apiKey}` },
  });
  check(res, { "evaluate is 200": (r) => r.status === 200, "has a boolean value": (r) => typeof r.json("value") === "boolean" });
}

/** The dashboard loading a project's flag list. Hits PostgreSQL every time (not cached). */
export function dashboardRead(data) {
  const res = http.get(`${BASE}${data.flagsPath}`, { headers: { Authorization: `Bearer ${data.token}` } });
  check(res, { "list is 200": (r) => r.status === 200 });
}
