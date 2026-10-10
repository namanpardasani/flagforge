import type { Express } from "express";
import { pino } from "pino";
import request from "supertest";
import { createApp, type AppDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { RateLimits } from "../src/rate-limits.js";
import { createRedisServices } from "../src/redis/index.js";
import { prisma } from "../src/db.js";

export const testConfig = loadConfig({
  ...process.env,
  JWT_ACCESS_SECRET: "test-secret-test-secret-test-secret-123456",
  BCRYPT_ROUNDS: "4", // fast hashing; real value is 12
  SSE_HEARTBEAT_MS: "150", // fast timers so stream tests do not need long waits
  SSE_REVALIDATE_MS: "300",
  SSE_MAX_CONNECTIONS_PER_KEY: "3",
});

/** Real Redis (database 15). Tests fail loudly if it is not running, so a silent fallback cannot hide a bug. */
export const testRedis = createRedisServices({ REDIS_URL: process.env["TEST_REDIS_URL"], RATE_LIMIT_ENABLED: true });
if (!(await testRedis.waitUntilReady(5000))) {
  throw new Error("Redis is not reachable at TEST_REDIS_URL. Start it with: docker compose up -d");
}

const unlimited = { capacity: 1_000_000, windowMs: 60_000 };
/** Rate limits so high they never trigger, so ordinary tests are not throttled. Rate-limit tests override them. */
export const noLimits: RateLimits = {
  global: unlimited,
  sdkPerIp: unlimited,
  register: unlimited,
  login: unlimited,
  loginPerIp: unlimited,
  refresh: unlimited,
  sdkFlags: unlimited,
  sdkEvaluate: unlimited,
  sdkStream: unlimited,
};

export function makeApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    logger: pino({ level: "silent" }),
    config: testConfig,
    prisma,
    checkDatabase: async () => {},
    redis: testRedis,
    limits: noLimits,
    ...overrides,
  });
}

/** Empties every table. Safe only because setup.ts guarantees we are on the _test database. */
export async function resetDb() {
  await testRedis.client?.flushdb(); // cached configs/keys/limits from the previous test must not leak into this one
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ApiKey", "AuditLog", "FlagState", "Flag", "RefreshToken", "WorkspaceMember", "Environment", "Project", "Workspace", "User" CASCADE',
  );
}

/** Registers a user and returns their id plus a ready-to-use Authorization header. */
export async function registerUser(app: Express, email: string) {
  const res = await request(app)
    .post("/auth/register")
    .send({ email, password: "correct horse battery", name: email.split("@")[0] });
  return {
    id: res.body.user.id as string,
    email,
    auth: `Bearer ${res.body.accessToken as string}`,
  };
}

export type TestUser = Awaited<ReturnType<typeof registerUser>>;

export { prisma };
