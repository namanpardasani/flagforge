// A small load generator with no dependencies, for machines where k6 is not available.
// It runs the same three scenarios as flagforge.js (the k6 script), which remains the main tool.
//
//   node loadtest/node-load.mjs                       # 200 requests/second per scenario, 20s each
//   RATE=1000 DURATION=30 node loadtest/node-load.mjs
//
// How it measures: requests are sent at a FIXED rate whatever the server does, and each latency is
// counted from the moment the request was DUE to be sent, not from when it actually left. If the
// server (or this script) falls behind, the waiting shows up in the numbers instead of being
// hidden. (Measuring only from the actual send time is a classic mistake called "coordinated
// omission": a stalled server makes the tool send less, so the stall barely registers.)
//
// Limits: one Node process on the same machine as the server, so the two compete for CPU. Treat
// the results as "this laptop", not as capacity planning.
import http from "node:http";
import { performance } from "node:perf_hooks";

const BASE = new URL(process.env.BASE_URL ?? "http://localhost:3000");
const RATE = Number(process.env.RATE ?? 200);
const DURATION_S = Number(process.env.DURATION ?? 20);
const FLAGS = Number(process.env.FLAGS ?? 20);

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

/** One request. Resolves with the status code, or 0 if it failed at the network level. */
function send({ method = "GET", path, headers = {}, body }) {
  return new Promise((resolve) => {
    const req = http.request({ host: BASE.hostname, port: BASE.port, path, method, agent, headers: body ? { ...headers, "Content-Length": Buffer.byteLength(body) } : headers }, (res) => {
      res.resume(); // read and discard the body
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", () => resolve(0));
    req.end(body);
  });
}

async function api(method, path, body, token) {
  const res = await fetch(new URL(path, BASE), { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return { json: res.status === 204 ? null : await res.json(), headers: res.headers };
}

/** Builds a workspace with flags and an API key through the public API (same as the k6 setup). */
async function setup() {
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const token = (await api("POST", "/auth/register", { email: `load-${tag}@flagforge.local`, password: `load-test-${tag}-not-a-real-account`, name: "Load test" })).json.accessToken;
  const ws = (await api("POST", "/workspaces", { name: `Load ${tag}`, slug: `load-${tag}` }, token)).json;
  const project = (await api("POST", `/workspaces/${ws.id}/projects`, { name: "Load", key: "load" }, token)).json;
  const env = project.environments.find((e) => e.key === "prod");
  const flagsPath = `/workspaces/${ws.id}/projects/${project.id}/flags`;
  const flagKeys = [];
  for (let i = 0; i < FLAGS; i++) {
    const key = `load-flag-${i}`;
    const flag = (await api("POST", flagsPath, { key, name: `Load flag ${i}` }, token)).json;
    const state =
      i % 3 === 0 ? { enabled: false } : i % 3 === 1 ? { enabled: true, rolloutPercentage: 50 } : { enabled: true, rolloutPercentage: 10, rules: [{ conditions: [{ attribute: "plan", operator: "equals", value: "pro" }], rolloutPercentage: 100 }] };
    await api("PUT", `${flagsPath}/${flag.id}/environments/${env.id}`, state, token);
    flagKeys.push(key);
  }
  const apiKey = (await api("POST", `/workspaces/${ws.id}/projects/${project.id}/environments/${env.id}/api-keys`, { name: "load test" }, token)).json.key;
  const etag = (await api("GET", "/sdk/v1/flags", undefined, apiKey)).headers.get("etag");
  return { token, apiKey, flagKeys, flagsPath, etag };
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function run(name, expected, makeRequest) {
  const total = RATE * DURATION_S;
  const latencies = new Float64Array(total);
  const statuses = new Map();
  let finished = 0;
  let sent = 0;
  const started = performance.now();

  await new Promise((done) => {
    const tick = setInterval(() => {
      // How many requests should have been sent by now at the fixed rate.
      const due = Math.min(total, Math.floor(((performance.now() - started) / 1000) * RATE));
      while (sent < due) {
        const index = sent++;
        const dueAt = started + (index / RATE) * 1000; // when this request was supposed to leave
        void send(makeRequest()).then((status) => {
          latencies[index] = performance.now() - dueAt;
          statuses.set(status, (statuses.get(status) ?? 0) + 1);
          if (++finished === total) done();
        });
      }
      if (sent >= total) clearInterval(tick);
    }, 2);
  });

  const elapsed = (performance.now() - started) / 1000;
  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const ok = statuses.get(expected) ?? 0;
  const round = (n) => Math.round(n * 10) / 10;
  return {
    scenario: name,
    requests: total,
    targetRps: RATE,
    achievedRps: round(total / elapsed),
    failed: total - ok,
    statuses: Object.fromEntries(statuses),
    ms: { avg: round(sorted.reduce((a, b) => a + b, 0) / total), p50: round(percentile(sorted, 50)), p90: round(percentile(sorted, 90)), p95: round(percentile(sorted, 95)), p99: round(percentile(sorted, 99)), max: round(sorted[total - 1]) },
  };
}

const data = await setup();
const key = { Authorization: `Bearer ${data.apiKey}` };
const results = [];

// Warm up connections and caches, so the first scenario is not charged for opening sockets.
await run("warm-up", 304, () => ({ path: "/sdk/v1/flags", headers: { ...key, "If-None-Match": data.etag } }));

results.push(await run("sdkPoll (GET /sdk/v1/flags, 304)", 304, () => ({ path: "/sdk/v1/flags", headers: { ...key, "If-None-Match": data.etag } })));
results.push(
  await run("sdkEvaluate (POST /sdk/v1/evaluate)", 200, () => {
    const user = Math.floor(Math.random() * 100000);
    const flagKey = data.flagKeys[Math.floor(Math.random() * data.flagKeys.length)];
    return { method: "POST", path: "/sdk/v1/evaluate", headers: { ...key, "Content-Type": "application/json" }, body: JSON.stringify({ flagKey, context: { key: `user-${user}`, attributes: { plan: user % 4 === 0 ? "pro" : "free" } } }) };
  }),
);
results.push(await run("dashboardRead (GET .../flags)", 200, () => ({ path: data.flagsPath, headers: { Authorization: `Bearer ${data.token}` } })));

console.table(results.map((r) => ({ scenario: r.scenario, "target rps": r.targetRps, "achieved rps": r.achievedRps, failed: r.failed, avg: r.ms.avg, p50: r.ms.p50, p95: r.ms.p95, p99: r.ms.p99, max: r.ms.max })));
console.log(JSON.stringify({ rate: RATE, durationSeconds: DURATION_S, flags: FLAGS, node: process.version, results }));
agent.destroy();
process.exitCode = results.some((r) => r.failed > 0) ? 1 : 0;
