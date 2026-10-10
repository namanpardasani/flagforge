import "dotenv/config";

// Tests must never touch the dev database: point the app's DATABASE_URL at the test database
// before any module reads it, and refuse to run if the name does not end in _test.
const testUrl = process.env["TEST_DATABASE_URL"];
if (!testUrl) {
  throw new Error("TEST_DATABASE_URL is not set (see apps/server/.env.example).");
}
if (!/\/[^/?]+_test(\?|$)/.test(testUrl)) {
  throw new Error("TEST_DATABASE_URL must point to a database whose name ends in _test.");
}
const testRedisUrl = process.env["TEST_REDIS_URL"];
if (!testRedisUrl) {
  throw new Error("TEST_REDIS_URL is not set (see apps/server/.env.example).");
}
// Tests flush their Redis database, so only databases 10-15 are allowed, never the default 0.
if (!/^rediss?:\/\/[^/]+\/(1[0-5])$/.test(testRedisUrl)) {
  throw new Error("TEST_REDIS_URL must select Redis database 10-15 (e.g. redis://localhost:6379/15).");
}
process.env["DATABASE_URL"] = testUrl;
process.env["NODE_ENV"] = "test";
