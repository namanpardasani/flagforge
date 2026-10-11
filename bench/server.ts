// Starts the API server the way the benchmarks need it, and keeps it in the foreground.
//
//   pnpm bench:server          (leave it running; use another terminal for the benchmarks)
//
// It is the production BUNDLE (the same dist/server.js a deployment runs), on its own port, with:
//  - RATE_LIMIT_ENABLED=false : otherwise the benchmarks measure the rate limiter. One key polled by
//    50 SDKs 100 times is 5,000 requests in under a minute; the per-key limit is 1,200 a minute.
//  - REDIS_URL set            : the config cache, key cache and cross-instance events are on.
//  - Redis database 2         : not the one development (0) or the tests (15) use.
//  - NODE_ENV=development     : NODE_ENV=production refuses to start without a real email provider
//    (MAIL_PROVIDER=log is development-only), and a benchmark must not send real email. Nothing
//    measured here behaves differently between the two settings.
// Database settings come from apps/server/.env, exactly as in development. Local services only.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverDir = fileURLToPath(new URL("../apps/server/", import.meta.url));
export const BENCH_PORT = 3070;
export const BENCH_REDIS = "redis://localhost:6379/2";

const built = spawnSync("node", ["build.mjs"], { cwd: serverDir, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

const child = spawn("node", ["dist/server.js"], {
  cwd: serverDir,
  stdio: "inherit",
  env: { ...process.env, PORT: String(BENCH_PORT), NODE_ENV: "development", RATE_LIMIT_ENABLED: "false", REDIS_URL: BENCH_REDIS, LOG_LEVEL: "warn" },
});
console.log(`benchmark server starting on http://localhost:${BENCH_PORT} (rate limits off, Redis on). Ctrl+C to stop.`);
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
