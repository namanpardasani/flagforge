import { z } from "zod";

const key = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, "Use lowercase letters, numbers, dots, underscores and hyphens");
const name = z.string().trim().min(1).max(100);
const description = z.string().trim().max(500);

export const createFlagSchema = z.object({ key, name, description: description.optional() });

export const updateFlagSchema = z
  .object({ name: name.optional(), description: description.nullable().optional() })
  .refine((v) => v.name !== undefined || v.description !== undefined, "Provide name or description");

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const id = z.string().min(1).max(64);
export const flagsParams = z.object({ workspaceId: id, projectId: id });
export const flagParams = z.object({ workspaceId: id, projectId: id, flagId: id });
export const flagStateParams = z.object({ workspaceId: id, projectId: id, flagId: id, environmentId: id });

export type CreateFlagInput = z.infer<typeof createFlagSchema>;
export type UpdateFlagInput = z.infer<typeof updateFlagSchema>;
