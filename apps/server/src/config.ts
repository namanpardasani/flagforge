import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  // Real-time streams (SSE). The heartbeat keeps proxies from closing idle connections.
  SSE_HEARTBEAT_MS: z.coerce.number().int().min(50).default(25_000),
  SSE_REVALIDATE_MS: z.coerce.number().int().min(100).default(60_000),
  SSE_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(2000),
  SSE_MAX_CONNECTIONS_PER_KEY: z.coerce.number().int().min(1).default(50),
  // Redis is optional: without it the server still works (no cache, per-instance rate limits and events).
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\//, "REDIS_URL must start with redis:// or rediss://")
    .optional(),
  // How many reverse proxies sit in front (Render, nginx...). Needed so rate limits see the real client IP.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  /**
   * Browser origins allowed to call the API, comma separated (e.g. "https://app.example.com").
   * Unset: any origin in development, NONE in production. A deployed API must name its frontend,
   * so a forgotten setting fails closed instead of leaving the API open to every website.
   */
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((value) => (value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean))
    .pipe(
      z.array(
        z.string().refine((origin) => {
          try {
            const url = new URL(origin);
            // An origin is scheme + host (+ port): no path, query or trailing slash.
            return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin;
          } catch {
            return false;
          }
        }, "CORS_ORIGINS entries must be origins like https://app.example.com (no path, no trailing slash)"),
      ),
    ),
  // ---- email (verification and password reset) ----
  /** Where emailed links point: the dashboard's address. Used to build "confirm your email" links. */
  APP_URL: z.url().default("http://localhost:5173"),
  /**
   * log   : write messages to the server log (development only; refused in production)
   * brevo : Brevo's HTTP API (free: 300 a day, verify one sender address)
   * resend: Resend's HTTP API (free, but delivers only to a domain you have verified)
   */
  MAIL_PROVIDER: z.enum(["log", "brevo", "resend"]).default("log"),
  MAIL_API_KEY: z.string().min(10).optional(),
  MAIL_FROM: z
    .string()
    .regex(/^(?:[^<>\r\n]+<[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)$/, 'MAIL_FROM must look like "FlagForge <no-reply@example.com>" or no-reply@example.com')
    .default("FlagForge <no-reply@flagforge.local>"),
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const checked = envSchema.superRefine((env, ctx) => {
  if (env.MAIL_PROVIDER !== "log" && !env.MAIL_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["MAIL_API_KEY"], message: `MAIL_API_KEY is required when MAIL_PROVIDER is ${env.MAIL_PROVIDER}` });
  }
  if (env.NODE_ENV === "production" && env.MAIL_PROVIDER === "log") {
    // The messages hold single-use secret links; a production log is not a private place for them.
    ctx.addIssue({ code: "custom", path: ["MAIL_PROVIDER"], message: "MAIL_PROVIDER=log is for development only. Set MAIL_PROVIDER to brevo or resend (and MAIL_API_KEY) in production" });
  }
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = checked.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
