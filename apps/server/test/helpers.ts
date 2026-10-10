import type { Express } from "express";
import { pino } from "pino";
import request from "supertest";
import { createApp, type AppDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { prisma } from "../src/db.js";

export const testConfig = loadConfig({
  ...process.env,
  JWT_ACCESS_SECRET: "test-secret-test-secret-test-secret-123456",
  BCRYPT_ROUNDS: "4", // fast hashing; real value is 12
});

export function makeApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    logger: pino({ level: "silent" }),
    config: testConfig,
    prisma,
    checkDatabase: async () => {},
    ...overrides,
  });
}

/** Empties every table. Safe only because setup.ts guarantees we are on the _test database. */
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "WorkspaceMember", "Environment", "Project", "Workspace", "User" CASCADE',
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
