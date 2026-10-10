import { z } from "zod";

const attributeValue = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.array(z.string().max(256)).max(50)]);

/** Who the SDK is asking about. `key` is the stable user id that decides rollout bucketing. */
export const contextSchema = z.object({
  key: z.string().min(1).max(256),
  attributes: z
    .record(z.string().min(1).max(100), attributeValue)
    .refine((a) => Object.keys(a).length <= 50, "At most 50 attributes")
    .optional(),
});

export const evaluateSchema = z.object({
  flagKey: z.string().min(1).max(60),
  context: contextSchema,
});

export const evaluateAllSchema = z.object({ context: contextSchema });
