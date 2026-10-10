import { Router } from "express";

export type DatabaseCheck = () => Promise<void>;
export type RedisCheck = () => Promise<"disabled" | "up" | "down">;

/**
 * Postgres is required: if it is down the server cannot do its job, so the response is 503.
 * Redis is an optimisation: if it is down the server still works (slower, per-instance limits),
 * so the response stays 200 but says "degraded" for dashboards and alerts.
 */
export function healthRouter(checkDatabase: DatabaseCheck, checkRedis: RedisCheck = async () => "disabled"): Router {
  const router = Router();

  router.get("/health", async (req, res) => {
    const redis = await checkRedis().catch(() => "down" as const);
    try {
      await checkDatabase();
      res.json({ status: redis === "down" ? "degraded" : "ok", database: "up", redis });
    } catch (err) {
      // Log the real reason; tell the client only that the database is down.
      req.log?.error({ err }, "health check: database unreachable");
      res.status(503).json({ status: "degraded", database: "down", redis });
    }
  });

  return router;
}
