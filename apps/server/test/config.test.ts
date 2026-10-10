import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults and coerces PORT to a number", () => {
    const config = loadConfig({ DATABASE_URL: "postgresql://x", PORT: "4000" });
    expect(config.PORT).toBe(4000);
    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("fails fast with a readable message when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/Invalid environment configuration[\s\S]*DATABASE_URL/);
  });

  it("rejects an invalid PORT", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgresql://x", PORT: "99999" })).toThrow(/PORT/);
  });
});
