import { Router } from "express";
import { loginSchema, refreshSchema, registerSchema } from "../auth/schemas.js";
import type { AuthService } from "../auth/service.js";
import type { Config } from "../config.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validate } from "../middleware/validate.js";

export function authRouter(auth: AuthService, config: Config): Router {
  const router = Router();

  router.post("/auth/register", validate(registerSchema), async (req, res) => {
    res.status(201).json(await auth.register(req.body));
  });

  router.post("/auth/login", validate(loginSchema), async (req, res) => {
    res.json(await auth.login(req.body));
  });

  router.post("/auth/refresh", validate(refreshSchema), async (req, res) => {
    res.json(await auth.refresh(req.body.refreshToken));
  });

  router.post("/auth/logout", validate(refreshSchema), async (req, res) => {
    await auth.logout(req.body.refreshToken);
    res.status(204).end();
  });

  router.get("/auth/me", requireAuth(config), async (req, res) => {
    res.json({ user: await auth.getUser(req.userId!) });
  });

  return router;
}
