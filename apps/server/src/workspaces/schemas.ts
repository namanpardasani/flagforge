import { z } from "zod";

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens"),
});

// OWNER is deliberately not assignable here; ownership transfer is a separate feature.
const assignableRole = z.enum(["ADMIN", "MEMBER", "VIEWER"]);

export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: assignableRole,
});

export const updateMemberSchema = z.object({ role: assignableRole });

const id = z.string().min(1).max(64);
export const workspaceParams = z.object({ workspaceId: id });
export const memberParams = z.object({ workspaceId: id, userId: id });

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
