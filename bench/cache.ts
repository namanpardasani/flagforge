// MEASUREMENT 4: how many database reads the Redis cache removes from the SDK config endpoint.
//
//   pnpm bench:cache
//
// The same 1,000 requests to GET /sdk/v1/flags are sent twice against the real server code:
//   A) with Redis enabled (config cache + API key cache), starting from an EMPTY cache, and
//   B) with Redis disabled, where every request reads PostgreSQL.
//
// The server runs inside this process (the real createApp from apps/server, over real HTTP on a
// local port) so the database client can be wrapped with a counter. No application code is changed.
//
// Queries are counted two independent ways, and both are reported:
//   1. Database operations issued by the server's Prisma client, counted by a wrapper around the
//      client (`$extends` with `$allOperations`). Exact, and broken down by operation.
//   2. PostgreSQL's own statistics: scans started on the application's tables
//      (pg_stat_user_tables: seq_scan + idx_scan). This is the database's count, not ours.
// (pg_stat_statements would be the usual tool, but it must be preloaded in the PostgreSQL
// configuration and the docker-compose image does not load it; changing that is out of scope.)
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { environment } from "./env.ts";
import { sleep } from "./stats.ts";

// The server reads its settings from apps/server/.env. Load that file before importing the server.
process.loadEnvFile(fileURLToPath(new URL("../apps/server/.env", import.meta.url)));
const { createApp } = await import("../apps/server/src/app.ts");
const { loadConfig } = await import("../apps/server/src/config.ts");
const { prisma } = await import("../apps/server/src/db.ts");
const { createRedisServices } = await import("../apps/server/src/redis/index.ts");
const { setup } = await import("./api.ts");

const REQUESTS = Number(process.env["REQUESTS"] ?? 1000);
const FLAGS = 20;
const BENCH_REDIS = "redis://localhost:6379/3"; // its own Redis database, flushed at the start of run A
/** PostgreSQL publishes a session's statistics when it has been idle for a while. Wait longer than that. */
const STATS_SETTLE_MS = 12_000;

const unlimited = { capacity: 1_000_000_000, windowMs: 60_000 };
const noLimits = { global: unlimited, sdkPerIp: unlimited, register: unlimited, login: unlimited, loginPerIp: unlimited, refresh: unlimited, sdkFlags: unlimited, sdkEvaluate: unlimited, sdkStream: unlimited, sdkEvents: unlimited };

// ---- counter 1: what the server's database client is asked to do --------------------------------
const operations = new Map<string, number>();
let counting = false;
const counted = prisma.$extends({
  query: {
    $allOperations({ model, operation, args, query }) {
      if (counting) {
        const name = model ? `${model}.${operation}` : operation;
        operations.set(name, (operations.get(name) ?? 0) + 1);
      }
      return query(args);
    },
  },
});

// ---- counter 2: PostgreSQL's own statistics (read with the unwrapped client, never counted) ------
async function tableScans(): Promise<number> {
  const rows = await prisma.$queryRaw<{ scans: bigint }[]>`SELECT COALESCE(SUM(seq_scan + COALESCE(idx_scan, 0)), 0)::bigint AS scans FROM pg_stat_user_tables`;
  return Number(rows[0]!.scans);
}
async function otherSessions(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'`;
  return Number(rows[0]!.n);
}

async function listen(app: ReturnType<typeof createApp>) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}

async function run(label: string, redisUrl: string | undefined, apiKey: string) {
  const redis = createRedisServices({ REDIS_URL: redisUrl, RATE_LIMIT_ENABLED: false });
  if (redisUrl) {
    if (!(await redis.waitUntilReady(5000))) throw new Error("Redis is not reachable. Start it with: docker compose up -d");
    await redis.client!.flushdb(); // start from an empty cache: the first request has to fill it
  }
  const config = loadConfig({ ...process.env, NODE_ENV: "development", REDIS_URL: redisUrl, RATE_LIMIT_ENABLED: "false", LOG_LEVEL: "silent" });
  const app = createApp({ logger: pino({ level: "silent" }), config, prisma: counted as unknown as typeof prisma, checkDatabase: async () => {}, redis, limits: noLimits });
  const server = await listen(app);

  await sleep(STATS_SETTLE_MS); // let earlier activity reach the statistics before taking the baseline
  const scansBefore = await tableScans();
  operations.clear();
  counting = true;

  const statuses: Record<number, number> = {};
  const started = performance.now();
  for (let i = 0; i < REQUESTS; i++) {
    const res = await fetch(`${server.url}/sdk/v1/flags`, { headers: { Authorization: `Bearer ${apiKey}` } });
    await res.arrayBuffer();
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
  }
  const seconds = (performance.now() - started) / 1000;

  counting = false;
  await sleep(STATS_SETTLE_MS);
  const scans = (await tableScans()) - scansBefore;
  const byOperation = Object.fromEntries([...operations.entries()].sort());
  const total = [...operations.values()].reduce((a, b) => a + b, 0);

  console.log(`\n## ${label}\n`);
  console.log(`requests: ${REQUESTS}   responses by status: ${JSON.stringify(statuses)}   took ${seconds.toFixed(2)} s (${Math.round(REQUESTS / seconds)} requests/second, one at a time)`);
  console.log(`database operations issued by the server: ${total}`);
  console.log(`  by operation: ${JSON.stringify(byOperation)}`);
  console.log(`table scans recorded by PostgreSQL (pg_stat_user_tables): ${scans}`);

  await server.close();
  await redis.close();
  return { label, requests: REQUESTS, statuses, operations: total, byOperation, tableScans: scans };
}

console.log("# Database read reduction from the Redis cache\n");
console.log("environment:", JSON.stringify(environment(), null, 2));
const busy = await otherSessions();
console.log(`other active sessions on this database at the start: ${busy}${busy > 0 ? "  (WARNING: the PostgreSQL-side count below will include their work)" : ""}`);

// Data is created once, through the public API of a throwaway server (rate limits off, no Redis).
const setupRedis = createRedisServices({ REDIS_URL: undefined, RATE_LIMIT_ENABLED: false });
const setupServer = await listen(createApp({ logger: pino({ level: "silent" }), config: loadConfig({ ...process.env, REDIS_URL: undefined, RATE_LIMIT_ENABLED: "false", LOG_LEVEL: "silent" }), prisma, checkDatabase: async () => {}, redis: setupRedis, limits: noLimits }));
const data = await setup(FLAGS, setupServer.url);
await setupServer.close();
console.log(`data: 1 environment with ${FLAGS} flags, 1 API key`);

const withCache = await run("A) Redis cache ENABLED (starting empty)", BENCH_REDIS, data.apiKey);
const withoutCache = await run("B) Redis cache DISABLED", undefined, data.apiKey);

const reduction = (without: number, withIt: number) => (without === 0 ? Number.NaN : ((without - withIt) / without) * 100);
console.log("\n## Result\n");
console.log(`database operations for ${REQUESTS} requests:  without cache ${withoutCache.operations},  with cache ${withCache.operations}`);
console.log(`  reduction = (without - with) / without = (${withoutCache.operations} - ${withCache.operations}) / ${withoutCache.operations} = ${reduction(withoutCache.operations, withCache.operations).toFixed(2)}%`);
console.log(`PostgreSQL table scans for the same requests:  without cache ${withoutCache.tableScans},  with cache ${withCache.tableScans}`);
console.log(`  reduction = (${withoutCache.tableScans} - ${withCache.tableScans}) / ${withoutCache.tableScans} = ${reduction(withoutCache.tableScans, withCache.tableScans).toFixed(2)}%`);
console.log("\n" + JSON.stringify({ requests: REQUESTS, flags: FLAGS, withCache, withoutCache }, null, 2));
await prisma.$disconnect();
process.exit(0);
