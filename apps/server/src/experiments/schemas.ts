import { z } from "zod";

const id = z.string().min(1).max(64);
// Same shape as a flag key: something a developer types into code.
const metricKey = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, "Use lowercase letters, numbers, dots, underscores and hyphens");

export const createExperimentSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    hypothesis: z.string().trim().max(500).optional(),
    flagId: id,
    environmentId: id,
    metricKey,
  })
  .strict();

export const experimentsParams = z.object({ workspaceId: id, projectId: id });
export const experimentParams = z.object({ workspaceId: id, projectId: id, experimentId: id });

// ---- events reported by SDKs ------------------------------------------------------------------

// A user key is whatever the application uses to identify someone. It is hashed before storage.
const userKey = z.string().min(1).max(256);

const exposure = z.object({ type: z.literal("exposure"), flagKey: z.string().min(1).max(60), userKey, value: z.boolean() }).strict();
const conversion = z.object({ type: z.literal("conversion"), metricKey: z.string().min(1).max(60), userKey }).strict();

/** Body of POST /sdk/v1/events. Batched, so one request can carry many users. */
export const eventsSchema = z.object({ events: z.array(z.discriminatedUnion("type", [exposure, conversion])).min(1).max(500) }).strict();

export type CreateExperimentInput = z.infer<typeof createExperimentSchema>;
export type SdkEvent = z.infer<typeof eventsSchema>["events"][number];
