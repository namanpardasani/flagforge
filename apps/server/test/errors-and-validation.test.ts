import express from "express";
import { pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "../src/errors.js";
import { errorHandler, notFoundHandler } from "../src/middleware/error-handler.js";
import { requestLogger } from "../src/middleware/request-logger.js";
import { validate } from "../src/middleware/validate.js";

// A tiny app that only exists in tests, to exercise the handler and validator in isolation.
function buildTestApp() {
  const app = express();
  app.use(requestLogger(pino({ level: "silent" })));
  app.use(express.json());

  app.get("/app-error", () => {
    throw new AppError(403, "FORBIDDEN", "You cannot do that", { hint: "ask an admin" });
  });
  app.get("/boom", () => {
    throw new Error("secret internal detail: db password is hunter2");
  });
  app.get("/async-boom", async () => {
    throw new Error("async failure");
  });

  const bodySchema = z.object({ name: z.string().min(1), age: z.coerce.number().int().min(0) });
  app.post("/items", validate(bodySchema), (req, res) => {
    res.json({ received: req.body });
  });

  const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) });
  app.get("/list", validate(querySchema, "query"), (req, res) => {
    res.json({ query: req.query });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("error handler", () => {
  const app = buildTestApp();

  it("returns AppError status, code, message and details", async () => {
    const res = await request(app).get("/app-error");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: "FORBIDDEN",
      message: "You cannot do that",
      details: { hint: "ask an admin" },
    });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("returns a generic 500 for unknown errors and never leaks details or stack", async () => {
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(res.body.error.message).toBe("Internal server error");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("stack");
    expect(text).not.toContain(".ts");
  });

  it("handles errors thrown in async handlers", async () => {
    const res = await request(app).get("/async-boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("validate middleware", () => {
  const app = buildTestApp();

  it("passes valid input through, replacing it with the parsed value", async () => {
    const res = await request(app).post("/items").send({ name: "flag", age: "5" });
    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ name: "flag", age: 5 });
  });

  it("returns 400 VALIDATION_ERROR listing each bad field", async () => {
    const res = await request(app).post("/items").send({ name: "", age: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const paths = res.body.error.details.map((d: { path: string }) => d.path).sort();
    expect(paths).toEqual(["age", "name"]);
  });

  it("validates query strings and applies defaults", async () => {
    const ok = await request(app).get("/list");
    expect(ok.body.query).toEqual({ limit: 10 });
    const bad = await request(app).get("/list?limit=1000");
    expect(bad.status).toBe(400);
  });
});
