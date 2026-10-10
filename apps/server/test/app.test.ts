import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

describe("GET /health", () => {
  it("returns 200 when the database check passes", async () => {
    const app = makeApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", database: "up" });
  });

  it("returns 503 without leaking the reason when the database check fails", async () => {
    const app = makeApp({
      checkDatabase: async () => {
        throw new Error("password authentication failed for user flagforge");
      },
    });
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "degraded", database: "down" });
    expect(JSON.stringify(res.body)).not.toContain("password");
  });
});

describe("app wiring", () => {
  const app = makeApp();

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 INVALID_JSON for a malformed body", async () => {
    const res = await request(app)
      .post("/health")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("generates a request id and returns it in the header", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses a safe incoming x-request-id and ignores an unsafe one", async () => {
    const good = await request(app).get("/health").set("x-request-id", "abc-123");
    expect(good.headers["x-request-id"]).toBe("abc-123");
    const bad = await request(app).get("/health").set("x-request-id", "bad id with spaces!");
    expect(bad.headers["x-request-id"]).not.toBe("bad id with spaces!");
  });

  it("sets security headers via helmet", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
