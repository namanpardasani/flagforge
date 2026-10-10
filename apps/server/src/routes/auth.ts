import { Router } from "express";
import { loginSchema, refreshSchema, registerSchema } from "../auth/schemas.js";
import type { AuthService } from "../auth/service.js";
import type { Config } from "../config.js";
import { clientIp, fingerprint, rateLimit } from "../middleware/rate-limit.js";
import { requireAuth } from "../middleware/require-auth.js";
import type { RateLimits } from "../rate-limits.js";
import type { RateLimiter } from "../redis/rate-limit.js";
import { validate } from "../middleware/validate.js";

export function authRouter(auth: AuthService, config: Config, limiter: RateLimiter, limits: RateLimits): Router {
  const router = Router();
  const byIp = (name: string, rule: RateLimits["register"]) =>
    rateLimit(limiter, { name, rule, key: (req) => fingerprint(clientIp(req)) });
  // Limits run BEFORE validation so malformed requests cannot be spammed for free.
  const loginPerAccount = rateLimit(limiter, {
    name: "login-account",
    rule: limits.login,
    key: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : "";
      return fingerprint(clientIp(req), email); // IP + account: an attacker can only lock themselves out
    },
  });

  router.post("/auth/register", byIp("register", limits.register), validate(registerSchema), async (req, res) => {
    res.status(201).json(await auth.register(req.body));
  });

  router.post("/auth/login", byIp("login-ip", limits.loginPerIp), loginPerAccount, validate(loginSchema), async (req, res) => {
    res.json(await auth.login(req.body));
  });

  router.post("/auth/refresh", byIp("refresh", limits.refresh), validate(refreshSchema), async (req, res) => {
    res.json(await auth.refresh(req.body.refreshToken));
  });

  router.post("/auth/logout", byIp("refresh", limits.refresh), validate(refreshSchema), async (req, res) => {
    await auth.logout(req.body.refreshToken);
    res.status(204).end();
  });

  router.get("/auth/me", requireAuth(config), async (req, res) => {
    res.json({ user: await auth.getUser(req.userId!) });
  });

  return router;
}
