import { z } from "zod";

/**
 * Settings come from environment variables and are checked once at startup, so a missing or
 * mistyped value stops the app with a clear message instead of failing later in a confusing way.
 */
const schema = z.object({
  FLAGFORGE_API_KEY: z.string().regex(/^ff_[A-Za-z0-9_-]{20,}$/, "must be a FlagForge API key (starts with ff_). Create one on the dashboard's API keys page"),
  FLAGFORGE_URL: z.url().default("http://localhost:3000"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Only this machine by default. Set to 0.0.0.0 on a host that must accept outside traffic. */
  HOST: z.string().min(1).default("127.0.0.1"),
  FEATURED_FLAG: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]*$/, "must look like a flag key")
    .max(60)
    .default("one-tap-checkout"),
});

export type DemoConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Names the variable and the problem. Never prints the value: it may be a secret.
    const problems = result.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Demo app configuration is invalid:\n${problems}\nSee apps/demo/.env.example`);
  }
  return result.data;
}
