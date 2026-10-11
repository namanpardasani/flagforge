import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { makeApp, testConfig } from "./helpers.js";

const withConfig = (overrides: Record<string, string>) => makeApp({ config: loadConfig({ ...process.env, JWT_ACCESS_SECRET: "test-secret-test-secret-test-secret-123456", ...overrides }) });
const APP = "https://app.flagforge.example";
const allowed = (res: request.Response) => res.headers["access-control-allow-origin"] as string | undefined;

describe("CORS", () => {
  it("in development with nothing configured, any origin may call (the dev proxy makes this moot anyway)", async () => {
    const res = await request(makeApp()).get("/health").set("Origin", "http://localhost:5173");
    expect(testConfig.CORS_ORIGINS).toEqual([]);
    expect(allowed(res)).toBe("http://localhost:5173");
  });

  it("allows exactly the configured origins and no other", async () => {
    const app = withConfig({ CORS_ORIGINS: `${APP}, https://preview.flagforge.example` });
    expect(allowed(await request(app).get("/health").set("Origin", APP))).toBe(APP);
    expect(allowed(await request(app).get("/health").set("Origin", "https://preview.flagforge.example"))).toBe("https://preview.flagforge.example");
    expect(allowed(await request(app).get("/health").set("Origin", "https://evil.example"))).toBeUndefined();
    // Look-alikes must not pass: a suffix, a prefix, a different scheme or port.
    for (const origin of [`${APP}.evil.example`, "https://evil-app.flagforge.example", "http://app.flagforge.example", `${APP}:8443`]) {
      expect(allowed(await request(app).get("/health").set("Origin", origin))).toBeUndefined();
    }
  });

  it("in production with nothing configured, no origin is allowed (fails closed)", async () => {
    const app = withConfig({ NODE_ENV: "production", MAIL_PROVIDER: "brevo", MAIL_API_KEY: "x".repeat(12) });
    const res = await request(app).get("/health").set("Origin", APP);
    expect(res.status).toBe(200); // the request itself is served; the browser is simply not told it may read it
    expect(allowed(res)).toBeUndefined();
  });

  it("answers the preflight for an allowed origin with the methods and headers the dashboard uses", async () => {
    const app = withConfig({ CORS_ORIGINS: APP });
    const res = await request(app).options("/workspaces").set("Origin", APP).set("Access-Control-Request-Method", "PUT").set("Access-Control-Request-Headers", "authorization,content-type");
    expect(res.status).toBe(204);
    expect(allowed(res)).toBe(APP);
    expect(res.headers["access-control-allow-methods"]).toContain("PUT");
    expect((res.headers["access-control-allow-headers"] as string).toLowerCase()).toContain("authorization");
    expect(res.headers["access-control-max-age"]).toBe("600");
  });

  it("does not answer a preflight from an origin that is not allowed", async () => {
    const app = withConfig({ CORS_ORIGINS: APP });
    const res = await request(app).options("/workspaces").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "DELETE");
    expect(allowed(res)).toBeUndefined();
  });

  it("never sends credentials permission (tokens travel in a header, not cookies)", async () => {
    const res = await request(withConfig({ CORS_ORIGINS: APP })).get("/health").set("Origin", APP);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("rejects a malformed setting at startup instead of silently allowing nothing or everything", () => {
    for (const bad of ["app.flagforge.example", "https://app.flagforge.example/", "https://app.flagforge.example/path", "*", "ftp://x.example"]) {
      expect(() => loadConfig({ ...process.env, JWT_ACCESS_SECRET: "x".repeat(32), CORS_ORIGINS: bad })).toThrow(/CORS_ORIGINS/);
    }
  });
});
