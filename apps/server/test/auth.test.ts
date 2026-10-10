import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/auth/tokens.js";
import { makeApp, prisma, resetDb, testConfig } from "./helpers.js";

const app = makeApp();
const creds = { email: "ada@example.com", password: "correct horse battery", name: "Ada" };

beforeEach(resetDb);

async function register(body: object = creds) {
  return request(app).post("/auth/register").send(body);
}

describe("POST /auth/register", () => {
  it("creates a user, returns tokens, and never returns the password hash", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "ada@example.com", name: "Ada" });
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it("stores a bcrypt hash and only a hash of the refresh token", async () => {
    const res = await register();
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "ada@example.com" } });
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(user.passwordHash).not.toContain(creds.password);
    const stored = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).toBe(hashToken(res.body.refreshToken));
    expect(stored[0]!.tokenHash).not.toBe(res.body.refreshToken);
  });

  it("normalises email case and rejects duplicates with 409", async () => {
    await register();
    const res = await register({ ...creds, email: "  ADA@Example.com " });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("rejects invalid input with 400", async () => {
    const bad = [
      { ...creds, email: "not-an-email" },
      { ...creds, password: "short" },
      { ...creds, password: "x".repeat(73) },
      { ...creds, name: "" },
      { email: creds.email },
    ];
    for (const body of bad) {
      const res = await register(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("POST /auth/login", () => {
  beforeEach(async () => {
    await register();
  });

  it("logs in with correct credentials", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "ADA@example.com", password: creds.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("gives the same 401 for a wrong password and an unknown email", async () => {
    const wrongPw = await request(app).post("/auth/login").send({ email: creds.email, password: "nope-nope-nope" });
    const noUser = await request(app).post("/auth/login").send({ email: "ghost@example.com", password: "nope-nope-nope" });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(noUser.body.error.message).toBe(wrongPw.body.error.message);
  });
});

describe("GET /auth/me and access tokens", () => {
  it("returns the current user for a valid token", async () => {
    const { body } = await register();
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(creds.email);
  });

  it("rejects missing, malformed, wrongly-signed, expired and alg=none tokens", async () => {
    const { body } = await register();
    const sub = body.user.id as string;
    const expired = jwt.sign({}, testConfig.JWT_ACCESS_SECRET, { subject: sub, expiresIn: -10 });
    const wrongKey = jwt.sign({}, "x".repeat(40), { subject: sub });
    const none = jwt.sign({ sub }, "", { algorithm: "none" });
    const headers = [undefined, "Bearer", "Bearer garbage", `Bearer ${expired}`, `Bearer ${wrongKey}`, `Bearer ${none}`, `Token ${body.accessToken}`];
    for (const header of headers) {
      const req = request(app).get("/auth/me");
      const res = await (header ? req.set("Authorization", header) : req);
      expect(res.status, String(header)).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("rejects a valid token whose user no longer exists", async () => {
    const { body } = await register();
    await prisma.user.delete({ where: { id: body.user.id } });
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${body.accessToken}`);
    expect(res.status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("issues new tokens and invalidates the old refresh token", async () => {
    const first = (await register()).body;
    const res = await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(first.refreshToken);
    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);

    const reuse = await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken });
    expect(reuse.status).toBe(401);
  });

  it("revokes the whole session set when an old token is reused", async () => {
    const first = (await register()).body;
    const second = (await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken })).body;
    await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken }); // theft attempt
    const res = await request(app).post("/auth/refresh").send({ refreshToken: second.refreshToken });
    expect(res.status).toBe(401);
  });

  it("only lets one of two simultaneous refreshes succeed", async () => {
    const first = (await register()).body;
    const results = await Promise.all([
      request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken }),
      request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("rejects unknown and expired refresh tokens", async () => {
    const unknown = await request(app).post("/auth/refresh").send({ refreshToken: "nope" });
    expect(unknown.status).toBe(401);

    const first = (await register()).body;
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken });
    expect(expired.status).toBe(401);
  });

  it("does not accept a refresh token as an access token", async () => {
    const first = (await register()).body;
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${first.refreshToken}`);
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the refresh token and is idempotent", async () => {
    const first = (await register()).body;
    const out = await request(app).post("/auth/logout").send({ refreshToken: first.refreshToken });
    expect(out.status).toBe(204);
    const again = await request(app).post("/auth/logout").send({ refreshToken: first.refreshToken });
    expect(again.status).toBe(204);
    const refresh = await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken });
    expect(refresh.status).toBe(401);
  });
});
