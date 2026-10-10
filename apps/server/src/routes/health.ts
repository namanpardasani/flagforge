import { Router } from "express";

export type DatabaseCheck = () => Promise<void>;

export function healthRouter(checkDatabase: DatabaseCheck): Router {
  const router = Router();

  router.get("/health", async (req, res) => {
    try {
      await checkDatabase();
      res.json({ status: "ok", database: "up" });
    } catch (err) {
      // Log the real reason; tell the client only that the database is down.
      req.log?.error({ err }, "health check: database unreachable");
      res.status(503).json({ status: "degraded", database: "down" });
    }
  });

  return router;
}
