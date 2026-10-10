import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgresql://x", JWT_ACCESS_SECRET: "a".repeat(32) };

describe("loadConfig", () => {
  it("applies defaults and coerces PORT to a number", () => {
    const config = loadConfig({ ...base, PORT: "4000" });
    expect(config.PORT).toBe(4000);
    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("fails fast with a readable message when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/Invalid environment configuration[\s\S]*DATABASE_URL/);
  });

  it("rejects a JWT secret shorter than 32 characters", () => {
    expect(() => loadConfig({ ...base, JWT_ACCESS_SECRET: "short" })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it("rejects an invalid PORT", () => {
    expect(() => loadConfig({ ...base, PORT: "99999" })).toThrow(/PORT/);
  });
});
