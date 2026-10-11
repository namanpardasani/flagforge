// MEASUREMENT 3 (Node version): load on GET /sdk/v1/flags in steps, to find where latency degrades.
//
//   pnpm bench:server        (terminal 1)
//   pnpm bench:ramp          (terminal 2)
//
// This does what loadtest/sdk-config.js (k6) does, with a Node load generator, for machines where k6
// is not installed. It is NOT k6 and must not be described as k6 results.
//
// Method: for each step, requests are sent at a FIXED rate for HOLD seconds, whatever the server does,
// and each latency is measured from when the request was DUE (so a stall that delays the sender is
// counted as latency, not hidden). A step's first 2 seconds are discarded as ramp-in.
//
// Because the generator shares this machine and one Node thread with... itself, it can become the
// bottleneck. It therefore measures its OWN event-loop delay: if that is large, the step shows the
// generator's limit, not the server's, and the step is flagged.
import http from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { BASE, call, setup } from "./api.ts";
import { environment } from "./env.ts";
import { percentile } from "./stats.ts";

const MODE = (process.env["MODE"] ?? "full") as "full" | "poll";
const HOLD_S = Number(process.env["HOLD"] ?? 15);
const RATES = (process.env["RATES"] ?? "100,250,500,1000,1500,2000,3000,4000").split(",").map(Number);
const RAMP_IN_S = 2;
const url = new URL(BASE);
const agent = new http.Agent({ keepAlive: true, maxSockets: 1024 });

const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<{ redis: string }>).catch(() => null);
if (!health || health.redis !== "up") throw new Error(`Need the benchmark server with Redis up at ${BASE} (pnpm bench:server). Got: ${JSON.stringify(health)}`);

const data = await setup(20);
const first = await fetch(`${BASE}/sdk/v1/flags`, { headers: { Authorization: `Bearer ${data.apiKey}` } });
const etag = first.headers.get("etag")!;
const bytes = (await first.arrayBuffer()).byteLength;
void call; // (imported for symmetry with the other scripts)

function send(): Promise<number> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${data.apiKey}` };
    if (MODE === "poll") headers["If-None-Match"] = etag;
    const req = http.request({ host: url.hostname, port: url.port, path: "/sdk/v1/flags", method: "GET", agent, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

const expected = MODE === "poll" ? 304 : 200;
interface Step { target: number; achieved: number; sent: number; failed: number; p50: number; p95: number; p99: number; max: number; loopP99: number; generatorStrained: boolean }

async function step(rate: number): Promise<Step> {
  const total = rate * HOLD_S;
  const latencies: number[] = [];
  let failed = 0;
  let finished = 0;
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const started = performance.now();
  let sent = 0;
  await new Promise<void>((done) => {
    const tick = setInterval(() => {
      const due = Math.min(total, Math.floor(((performance.now() - started) / 1000) * rate));
      while (sent < due) {
        const index = sent++;
        const dueAt = started + (index / rate) * 1000;
        void send().then((status) => {
          if (dueAt - started >= RAMP_IN_S * 1000) {
            latencies.push(performance.now() - dueAt);
            if (status !== expected) failed++;
          }
          if (++finished === total) done();
        });
      }
      if (sent >= total) clearInterval(tick);
    }, 2);
  });
  loop.disable();
  const seconds = (performance.now() - started) / 1000;
  const sorted = Float64Array.from(latencies).sort();
  const loopP99 = loop.percentile(99) / 1e6; // ns -> ms
  return { target: rate, achieved: Math.round((total / seconds) * 10) / 10, sent: total, failed, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted[sorted.length - 1] ?? 0, loopP99, generatorStrained: loopP99 > 20 };
}

console.log(`# Load ramp on GET /sdk/v1/flags (${MODE === "poll" ? "If-None-Match, answered 304" : "full response, 200"})\n`);
console.log("generator: Node (NOT k6), same machine as the server. environment:", JSON.stringify(environment(), null, 2));
console.log(`\nresponse size: ${bytes} bytes (20 flags). hold per step: ${HOLD_S}s (first ${RAMP_IN_S}s discarded). rates: ${RATES.join(", ")} requests/second\n`);
console.log("target | achieved |  failed |   p50 ms |   p95 ms |   p99 ms |   max ms | generator loop p99 ms");

const steps: Step[] = [];
await step(50); // warm-up: sockets, caches, JIT
for (const rate of RATES) {
  const s = await step(rate);
  steps.push(s);
  const f = (n: number) => n.toFixed(1).padStart(8);
  console.log(`${String(s.target).padStart(6)} | ${String(s.achieved).padStart(8)} | ${String(s.failed).padStart(7)} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.p99)} | ${f(s.max)} | ${s.loopP99.toFixed(1).padStart(8)}${s.generatorStrained ? "  <- generator strained" : ""}`);
}

// Degradation: the first step where p95 is more than 3x the lowest step's p95 (and at least 10 ms), where
// the rate was not sustained, or where any request failed.
const baseline = steps[0]!.p95;
const bad = steps.find((s) => s.failed > 0 || s.achieved < s.target * 0.98 || s.p95 > Math.max(10, baseline * 3));
const stable = bad ? [...steps].reverse().find((s) => steps.indexOf(s) < steps.indexOf(bad)) : steps[steps.length - 1];
console.log(`\nbaseline p95 (lowest step): ${baseline.toFixed(1)} ms`);
console.log(bad ? `first degraded step: ${bad.target} requests/second (p95 ${bad.p95.toFixed(1)} ms, achieved ${bad.achieved}/s, ${bad.failed} failed)${bad.generatorStrained ? "  NOTE: the generator itself was strained at this step, so this may be its limit and not the server's" : ""}` : "no step degraded: the limit is above the highest step tried");
console.log(stable ? `last stable step: ${stable.target} requests/second: p95 ${stable.p95.toFixed(1)} ms, achieved ${stable.achieved}/s, ${stable.failed} failed of ${stable.sent}` : "no stable step");
console.log("\n" + JSON.stringify({ mode: MODE, holdSeconds: HOLD_S, responseBytes: bytes, steps, firstDegraded: bad?.target ?? null, lastStable: stable?.target ?? null }, null, 1));
agent.destroy();
process.exit(0);
