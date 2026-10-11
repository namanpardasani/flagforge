// MEASUREMENT 2: how long a flag change takes to reach a running SDK.
//
//   pnpm bench:server        (terminal 1)
//   pnpm bench:propagation   (terminal 2)
//
// Everything is real: the API server process, PostgreSQL, Redis, and FlagForgeClient instances from
// packages/sdk holding open streams. For each of 100 flips:
//
//   start the clock -> send PUT .../flags/:id/environments/:id {enabled} to the real API
//                   -> ... server commits, bumps the version, publishes, streams "version N" ...
//                   -> the SDK refetches and swaps its config
//   stop the clock  when client.isEnabled(flag, user) returns the NEW value.
//
// The clock starts BEFORE the request is sent, so the API call itself is included. Polling is turned
// off in the SDK clients (pollIntervalMs: 0), so only the stream can deliver the change: a result
// here cannot be a lucky poll.
import { FlagForgeClient } from "@flagforge/sdk";
import { BASE, call, setup } from "./api.ts";
import { environment } from "./env.ts";
import { sleep, summarize } from "./stats.ts";

const FLIPS = Number(process.env["FLIPS"] ?? 100);
const WARM_UP_FLIPS = 5;
const TIMEOUT_MS = 5000;
const USER = { key: "propagation-user" };

const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<{ status: string; redis: string }>).catch(() => null);
if (!health) throw new Error(`No server at ${BASE}. Start it with: pnpm bench:server`);
if (health.redis !== "up") throw new Error(`Redis is "${health.redis}" on that server. This measurement needs Redis enabled (pnpm bench:server sets it).`);

const ms = (n: number) => n.toFixed(1);

async function scenario(clientCount: number) {
  const data = await setup(1);
  const flag = data.flags[0]!;
  // Rollout stays at 100%, so "enabled" alone decides the value for every user.
  await call("PUT", data.statePath(flag.id), { enabled: false, rolloutPercentage: 100 }, data.token);

  const clients = Array.from({ length: clientCount }, () => new FlagForgeClient({ apiKey: data.apiKey, baseUrl: BASE, pollIntervalMs: 0, streaming: true }));
  for (const client of clients) client.on("error", (error) => console.error(`  sdk error: ${error.message}`));
  await Promise.all(clients.map((client) => client.init()));
  const deadline = Date.now() + 15_000;
  while (clients.some((client) => client.status.stream !== "connected")) {
    if (Date.now() > deadline) throw new Error(`only ${clients.filter((c) => c.status.stream === "connected").length} of ${clientCount} SDK streams connected`);
    await sleep(20);
  }

  /** One flip. Resolves with each client's delay in ms (NaN = did not arrive in time). */
  async function flip(want: boolean) {
    const arrivals = clients.map(
      (client) =>
        new Promise<number>((resolve) => {
          const check = () => {
            if (client.isEnabled(flag.key, USER) !== want) return;
            off();
            clearTimeout(timer);
            resolve(performance.now());
          };
          const off = client.on("update", check);
          const timer = setTimeout(() => {
            off();
            resolve(Number.NaN);
          }, TIMEOUT_MS);
        }),
    );
    const start = performance.now();
    const request = call("PUT", data.statePath(flag.id), { enabled: want }, data.token).then(() => performance.now() - start);
    const [apiMs, times] = await Promise.all([request, Promise.all(arrivals)]);
    return { apiMs, delays: times.map((t) => t - start) };
  }

  let state = false;
  for (let i = 0; i < WARM_UP_FLIPS; i++) await flip((state = !state));

  const perClient: number[] = [];
  const slowestPerFlip: number[] = [];
  const apiTimes: number[] = [];
  let missed = 0;
  const rawLines: string[] = [];
  for (let i = 0; i < FLIPS; i++) {
    const { apiMs, delays } = await flip((state = !state));
    const arrived = delays.filter((d) => !Number.isNaN(d));
    missed += delays.length - arrived.length;
    perClient.push(...arrived);
    slowestPerFlip.push(Math.max(...arrived));
    apiTimes.push(apiMs);
    rawLines.push(clientCount === 1 ? ms(arrived[0] ?? Number.NaN) : `${ms(summarize(arrived).p50)}/${ms(Math.max(...arrived))}`);
    await sleep(30); // let the system settle; real flips are not back to back
  }
  for (const client of clients) client.close();

  const all = summarize(perClient);
  const slowest = summarize(slowestPerFlip);
  const api = summarize(apiTimes);
  console.log(`\n## ${clientCount} connected SDK${clientCount === 1 ? "" : "s"}: ${FLIPS} flips (after ${WARM_UP_FLIPS} warm-up flips)\n`);
  console.log(clientCount === 1 ? "raw delay per flip, ms:" : "raw per flip, ms (median across the SDKs / slowest SDK):");
  for (let i = 0; i < rawLines.length; i += 10) console.log("  " + rawLines.slice(i, i + 10).join("  "));
  console.log(`\nAPI call sent -> SDK value changed (every SDK, every flip; ${all.count} samples, ${missed} missed):`);
  console.log(`  p50 ${ms(all.p50)} ms   p95 ${ms(all.p95)} ms   p99 ${ms(all.p99)} ms   max ${ms(all.max)} ms   min ${ms(all.min)} ms   mean ${ms(all.mean)} ms`);
  if (clientCount > 1) console.log(`API call sent -> the LAST of the ${clientCount} SDKs had it (${slowest.count} flips):\n  p50 ${ms(slowest.p50)} ms   p95 ${ms(slowest.p95)} ms   max ${ms(slowest.max)} ms`);
  console.log(`for reference, the API call alone (request sent -> response received): p50 ${ms(api.p50)} ms   p95 ${ms(api.p95)} ms   max ${ms(api.max)} ms`);
  return { clients: clientCount, flips: FLIPS, missed, everySdk: all, lastSdk: slowest, apiCall: api };
}

console.log("# Update propagation delay\n");
console.log("environment:", JSON.stringify(environment(), null, 2));
console.log(`server: ${BASE}  health: ${JSON.stringify(health)}`);
const results = [];
for (const count of (process.env["CLIENTS"] ?? "1,50").split(",").map(Number)) results.push(await scenario(count));
console.log("\n## Summary\n");
console.log(JSON.stringify(results, null, 2));
process.exit(0);
