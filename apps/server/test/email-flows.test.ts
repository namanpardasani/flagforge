import { createHash } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { BrevoMailer, ResendMailer, parseFrom } from "../src/mail/mailer.js";
import { makeApp, noLimits, prisma, registerUser, resetDb, testConfig, testMailer } from "./helpers.js";

const app = makeApp();
const PASSWORD = "correct horse battery";
const sha = (token: string) => createHash("sha256").update(token).digest("hex");

/** The token in the most recent email to this address (it is in the link's fragment). */
const tokenIn = (to: string, subject?: RegExp) => {
  const mail = [...testMailer.sent].reverse().find((m) => m.to === to && (!subject || subject.test(m.subject)));
  const found = mail && /#token=([A-Za-z0-9_-]+)/.exec(mail.text);
  return found?.[1];
};
const register = (email: string, name = "Tove") => request(app).post("/auth/register").send({ email, password: PASSWORD, name });
const emailed = (to: string) => vi.waitFor(() => expect(testMailer.lastTo(to)).toBeDefined(), { timeout: 2000 });
const login = (email: string, password = PASSWORD) => request(app).post("/auth/login").send({ email, password });

beforeEach(async () => {
  await resetDb();
});

/**
 * A confirmed user with a clean mailbox. Registering also sends a confirmation email in the
 * background; wait for it and discard it so tests only see the emails they cause themselves.
 */
async function registered(email: string) {
  const user = await registerUser(app, email);
  await emailed(email);
  testMailer.sent.length = 0;
  return user;
}

describe("email verification", () => {
  it("registering sends a confirmation email and the new user starts unconfirmed", async () => {
    const res = await register("tove@example.com");
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(false);
    await emailed("tove@example.com");
    const mail = testMailer.lastTo("tove@example.com")!;
    expect(mail.subject).toMatch(/Confirm your email/);
    expect(mail.text).toContain("Welcome, Tove");
    expect(mail.text).toContain(`${testConfig.APP_URL}/verify-email#token=`); // a fragment, never a query string
    expect(mail.text).not.toMatch(/verify-email\?/);
    expect(mail.html).toContain("Confirm email");
  });

  it("opening the link confirms the address, once", async () => {
    await register("tove@example.com");
    await emailed("tove@example.com");
    const token = tokenIn("tove@example.com")!;
    expect((await request(app).post("/auth/verify-email").send({ token })).body).toEqual({ verified: true });
    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${(await login("tove@example.com")).body.accessToken}`);
    expect(me.body.user.emailVerified).toBe(true);
    // The same link a second time: spent.
    const again = await request(app).post("/auth/verify-email").send({ token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_TOKEN");
  });

  it("two simultaneous clicks: exactly one succeeds", async () => {
    await register("tove@example.com");
    await emailed("tove@example.com");
    const token = tokenIn("tove@example.com")!;
    const results = await Promise.all([1, 2, 3].map(() => request(app).post("/auth/verify-email").send({ token })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
  });

  it("stores only a hash of the token, never the token", async () => {
    await register("tove@example.com");
    await emailed("tove@example.com");
    const token = tokenIn("tove@example.com")!;
    const rows = await prisma.emailToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.kind).toBe("VERIFY_EMAIL");
  });

  it("rejects an expired link, an unknown one, garbage, and a reset token used as a verification token", async () => {
    await register("tove@example.com");
    await emailed("tove@example.com");
    const token = tokenIn("tove@example.com")!;
    await prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post("/auth/verify-email").send({ token })).body.error.code).toBe("INVALID_TOKEN");
    expect((await request(app).post("/auth/verify-email").send({ token: "x".repeat(43) })).body.error.code).toBe("INVALID_TOKEN");
    expect((await request(app).post("/auth/verify-email").send({ token: "short" })).status).toBe(400);
    expect((await request(app).post("/auth/verify-email").send({})).status).toBe(400);

    await request(app).post("/auth/forgot-password").send({ email: "tove@example.com" });
    await vi.waitFor(() => expect(tokenIn("tove@example.com", /Reset/)).toBeDefined());
    expect((await request(app).post("/auth/verify-email").send({ token: tokenIn("tove@example.com", /Reset/)! })).body.error.code).toBe("INVALID_TOKEN");
  });

  it("resend: a new link replaces the old one, which stops working", async () => {
    const reg = await register("tove@example.com");
    await emailed("tove@example.com");
    const first = tokenIn("tove@example.com")!;
    const auth = `Bearer ${reg.body.accessToken}`;
    expect((await request(app).post("/auth/resend-verification").set("Authorization", auth)).body).toEqual({ alreadyVerified: false });
    await vi.waitFor(() => expect(testMailer.sent.filter((m) => m.to === "tove@example.com")).toHaveLength(2));
    const second = tokenIn("tove@example.com")!;
    expect(second).not.toBe(first);
    expect((await request(app).post("/auth/verify-email").send({ token: first })).status).toBe(400);
    expect((await request(app).post("/auth/verify-email").send({ token: second })).status).toBe(200);
  });

  it("resend needs a signed-in user, and for a confirmed user sends nothing", async () => {
    expect((await request(app).post("/auth/resend-verification")).status).toBe(401);
    const user = await registerUser(app, "ready@example.com"); // confirmed by the helper
    testMailer.sent.length = 0;
    expect((await request(app).post("/auth/resend-verification").set("Authorization", user.auth)).body).toEqual({ alreadyVerified: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(testMailer.sent).toHaveLength(0);
  });

  it("a mail provider that is down does not break registration, and the user can ask again", async () => {
    testMailer.failNext = true;
    const res = await register("tove@example.com");
    expect(res.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(testMailer.sent).toHaveLength(0);
    const auth = `Bearer ${res.body.accessToken}`;
    await request(app).post("/auth/resend-verification").set("Authorization", auth).expect(200);
    await emailed("tove@example.com");
  });

  it("an unconfirmed person cannot be added to a workspace by email until they confirm", async () => {
    const owner = await registerUser(app, "owner@example.com");
    await register("tove@example.com");
    await emailed("tove@example.com");
    const ws = (await request(app).post("/workspaces").set("Authorization", owner.auth).send({ name: "Acme", slug: "acme" })).body.id;
    const add = () => request(app).post(`/workspaces/${ws}/members`).set("Authorization", owner.auth).send({ email: "tove@example.com", role: "MEMBER" });
    const refused = await add();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    await request(app).post("/auth/verify-email").send({ token: tokenIn("tove@example.com")! }).expect(200);
    expect((await add()).status).toBe(201);
  });
});

describe("forgot password", () => {
  it("emails a reset link to a known address", async () => {
    await registered("tove@example.com");
    const res = await request(app).post("/auth/forgot-password").send({ email: "tove@example.com" });
    expect(res.status).toBe(202);
    await emailed("tove@example.com");
    const mail = testMailer.lastTo("tove@example.com")!;
    expect(mail.subject).toMatch(/Reset your FlagForge password/);
    expect(mail.text).toContain(`${testConfig.APP_URL}/reset-password#token=`);
    expect(mail.text).toContain("expires in 60 minutes");
  });

  it("answers identically for an unknown address, and sends nothing", async () => {
    await registered("tove@example.com");
    const known = await request(app).post("/auth/forgot-password").send({ email: "tove@example.com" });
    const unknown = await request(app).post("/auth/forgot-password").send({ email: "nobody@example.com" });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(testMailer.sent.map((m) => m.to)).toEqual(["tove@example.com"]);
  });

  it("is case-insensitive about the address, and validates it", async () => {
    await registered("tove@example.com");
    await request(app).post("/auth/forgot-password").send({ email: "  TOVE@Example.com " }).expect(202);
    await emailed("tove@example.com");
    expect((await request(app).post("/auth/forgot-password").send({ email: "not-an-email" })).status).toBe(400);
    expect((await request(app).post("/auth/forgot-password").send({})).status).toBe(400);
  });

  it("asking twice leaves only the newest link working", async () => {
    await registered("tove@example.com");
    await request(app).post("/auth/forgot-password").send({ email: "tove@example.com" });
    await emailed("tove@example.com");
    const first = tokenIn("tove@example.com", /Reset/)!;
    await request(app).post("/auth/forgot-password").send({ email: "tove@example.com" });
    await vi.waitFor(() => expect(testMailer.sent).toHaveLength(2));
    const second = tokenIn("tove@example.com", /Reset/)!;
    expect((await request(app).post("/auth/reset-password").send({ token: first, password: "brand new password" })).status).toBe(400);
    expect((await request(app).post("/auth/reset-password").send({ token: second, password: "brand new password" })).status).toBe(200);
  });
});

describe("reset password", () => {
  async function requestReset(email = "tove@example.com") {
    testMailer.sent.length = 0;
    await request(app).post("/auth/forgot-password").send({ email }).expect(202);
    await emailed(email);
    return tokenIn(email, /Reset/)!;
  }

  it("sets the new password, signs everyone out, and tells the owner", async () => {
    await registered("tove@example.com");
    const session = (await login("tove@example.com")).body;
    const token = await requestReset();
    const res = await request(app).post("/auth/reset-password").send({ token, password: "a much better password" });
    expect(res.body).toEqual({ reset: true });

    expect((await login("tove@example.com")).status).toBe(401); // the old password no longer works
    expect((await login("tove@example.com", "a much better password")).status).toBe(200);
    // Every refresh token issued before the reset is dead.
    expect((await request(app).post("/auth/refresh").send({ refreshToken: session.refreshToken })).status).toBe(401);
    // And the owner is told.
    await vi.waitFor(() => expect(testMailer.sent.some((m) => /password was changed/.test(m.subject))).toBe(true));
  });

  it("a link works once, even if two people try at the same moment", async () => {
    await registered("tove@example.com");
    const token = await requestReset();
    const results = await Promise.all(["first password!", "second password!", "third password!"].map((password) => request(app).post("/auth/reset-password").send({ token, password })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    const winners = await Promise.all(["first password!", "second password!", "third password!"].map(async (p) => (await login("tove@example.com", p)).status));
    expect(winners.filter((status) => status === 200)).toHaveLength(1);
  });

  it("rejects an expired link, an unknown one, and a verification token", async () => {
    await registered("tove@example.com");
    const token = await requestReset();
    await prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request(app).post("/auth/reset-password").send({ token, password: "a much better password" });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe("INVALID_TOKEN");
    expect((await request(app).post("/auth/reset-password").send({ token: "y".repeat(43), password: "a much better password" })).status).toBe(400);

    await register("other@example.com");
    await vi.waitFor(() => expect(tokenIn("other@example.com", /Confirm/)).toBeDefined());
    const verifyToken = tokenIn("other@example.com", /Confirm/)!;
    expect((await request(app).post("/auth/reset-password").send({ token: verifyToken, password: "a much better password" })).status).toBe(400);
    expect((await login("other@example.com")).status).toBe(200); // untouched
  });

  it("applies the same password rules as registering, and a refused password does not spend the link", async () => {
    await registered("tove@example.com");
    const token = await requestReset();
    expect((await request(app).post("/auth/reset-password").send({ token, password: "short" })).status).toBe(400);
    expect((await request(app).post("/auth/reset-password").send({ token, password: "é".repeat(40) })).status).toBe(400); // over 72 bytes
    expect((await request(app).post("/auth/reset-password").send({ token, password: "a much better password" })).status).toBe(200);
  });

  it("receiving the email proves ownership, so the address becomes confirmed", async () => {
    await register("tove@example.com");
    await emailed("tove@example.com");
    testMailer.sent.length = 0;
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "tove@example.com" } })).emailVerifiedAt).toBeNull();
    const token = await requestReset();
    await request(app).post("/auth/reset-password").send({ token, password: "a much better password" }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "tove@example.com" } })).emailVerifiedAt).not.toBeNull();
  });

  it("resetting works for an account locked out by failed logins", async () => {
    const limited = makeApp({ limits: { ...noLimits, login: { capacity: 2, windowMs: 60_000 } } });
    await registered("tove@example.com");
    for (let i = 0; i < 4; i++) await request(limited).post("/auth/login").send({ email: "tove@example.com", password: "wrong wrong wrong" });
    expect((await request(limited).post("/auth/login").send({ email: "tove@example.com", password: PASSWORD })).status).toBe(429);
    const token = await requestReset();
    expect((await request(app).post("/auth/reset-password").send({ token, password: "a much better password" })).status).toBe(200);
  });
});

describe("rate limits", () => {
  const limited = (overrides: Record<string, { capacity: number; windowMs: number }>) => makeApp({ limits: { ...noLimits, ...overrides } });
  const rule = (capacity: number) => ({ capacity, windowMs: 3_600_000 });

  it("limits forgot-password per address, so one inbox cannot be flooded", async () => {
    const strict = limited({ forgotPasswordPerEmail: rule(2) });
    const ask = (email: string) => request(strict).post("/auth/forgot-password").send({ email });
    expect((await ask("tove@example.com")).status).toBe(202);
    expect((await ask("TOVE@example.com")).status).toBe(202);
    const third = await ask("tove@example.com");
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
    expect((await ask("someone-else@example.com")).status).toBe(202); // other addresses are unaffected
  });

  it("limits forgot-password per IP across addresses", async () => {
    const strict = limited({ forgotPassword: rule(3) });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await request(strict).post("/auth/forgot-password").send({ email: `p${i}@example.com` })).status);
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
  });

  it("limits resend per user and reset attempts per IP", async () => {
    const strict = limited({ resendVerification: rule(1), resetPassword: rule(2), verifyEmail: rule(2) });
    const reg = await request(strict).post("/auth/register").send({ email: "tove@example.com", password: PASSWORD, name: "T" });
    const auth = `Bearer ${reg.body.accessToken}`;
    expect((await request(strict).post("/auth/resend-verification").set("Authorization", auth)).status).toBe(200);
    expect((await request(strict).post("/auth/resend-verification").set("Authorization", auth)).status).toBe(429);
    const bad = { token: "z".repeat(43), password: "a much better password" };
    expect([(await request(strict).post("/auth/reset-password").send(bad)).status, (await request(strict).post("/auth/reset-password").send(bad)).status, (await request(strict).post("/auth/reset-password").send(bad)).status]).toEqual([400, 400, 429]);
    const verify = { token: "z".repeat(43) };
    expect([(await request(strict).post("/auth/verify-email").send(verify)).status, (await request(strict).post("/auth/verify-email").send(verify)).status, (await request(strict).post("/auth/verify-email").send(verify)).status]).toEqual([400, 400, 429]);
  });
});

describe("mail configuration and senders", () => {
  const base = { ...process.env, JWT_ACCESS_SECRET: "x".repeat(32) };

  it("defaults to the log sender in development and refuses it in production", () => {
    expect(loadConfig({ ...base, NODE_ENV: "development" }).MAIL_PROVIDER).toBe("log");
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/MAIL_PROVIDER=log is for development only/);
    expect(loadConfig({ ...base, NODE_ENV: "production", MAIL_PROVIDER: "brevo", MAIL_API_KEY: "k".repeat(20) }).MAIL_PROVIDER).toBe("brevo");
  });

  it("requires a key for a real provider, and never prints it when something is wrong", () => {
    expect(() => loadConfig({ ...base, MAIL_PROVIDER: "resend" })).toThrow(/MAIL_API_KEY is required/);
    const secret = "super-secret-provider-key-123456";
    let message = "";
    try {
      loadConfig({ ...base, MAIL_PROVIDER: "resend", MAIL_API_KEY: secret, MAIL_FROM: "not an address" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("MAIL_FROM");
    expect(message).not.toContain(secret);
  });

  it("parses the sender address", () => {
    expect(parseFrom("FlagForge <no-reply@example.com>")).toEqual({ name: "FlagForge", email: "no-reply@example.com" });
    expect(parseFrom("no-reply@example.com")).toEqual({ email: "no-reply@example.com" });
  });

  it("Brevo: posts the documented body with the key in a header, and errors never contain the key or the link", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("{}", { status: 201 }))) as unknown as typeof fetch;
    await new BrevoMailer("brevo-key-123456", "FlagForge <no-reply@example.com>", fake).send({ to: "tove@example.com", subject: "Hi", text: "plain #token=SECRETLINK", html: "<p>hi</p>" });
    expect(calls[0]!.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe("brevo-key-123456");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ sender: { name: "FlagForge", email: "no-reply@example.com" }, to: [{ email: "tove@example.com" }], subject: "Hi", textContent: "plain #token=SECRETLINK", htmlContent: "<p>hi</p>" });

    const refusing = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    const error = await new BrevoMailer("brevo-key-123456", "a@b.example", refusing).send({ to: "t@example.com", subject: "s", text: "#token=SECRETLINK" }).catch((e: Error) => e);
    expect((error as Error).message).toBe("brevo: the email service answered 401");
    const down = (async () => { throw new TypeError("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    const unreachable = await new BrevoMailer("brevo-key-123456", "a@b.example", down).send({ to: "t@example.com", subject: "s", text: "#token=SECRETLINK" }).catch((e: Error) => e);
    expect(String((unreachable as Error).message)).not.toMatch(/SECRETLINK|brevo-key/);
  });

  it("Resend: posts the documented body with a bearer key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    await new ResendMailer("re_key_1234567", "FlagForge <no-reply@example.com>", fake).send({ to: "tove@example.com", subject: "Hi", text: "plain" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer re_key_1234567");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ from: "FlagForge <no-reply@example.com>", to: ["tove@example.com"], subject: "Hi", text: "plain" });
  });

  it("the email templates escape what a person typed (a name cannot inject markup)", async () => {
    await request(app).post("/auth/register").send({ email: "xss@example.com", password: PASSWORD, name: '<img src=x onerror=alert(1)>' }).expect(201);
    await emailed("xss@example.com");
    const mail = testMailer.lastTo("xss@example.com")!;
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img");
  });
});
