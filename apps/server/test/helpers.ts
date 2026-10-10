import { pino } from "pino";
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

export { prisma };
