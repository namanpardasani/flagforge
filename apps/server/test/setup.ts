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
process.env["DATABASE_URL"] = testUrl;
process.env["NODE_ENV"] = "test";
