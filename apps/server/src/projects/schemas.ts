import { z } from "zod";

const key = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens");

const name = z.string().trim().min(1).max(100);

export const createProjectSchema = z.object({ name, key });
export const createEnvironmentSchema = z.object({ name, key });

const id = z.string().min(1).max(64);
export const projectParams = z.object({ workspaceId: id, projectId: id });
export const environmentParams = z.object({ workspaceId: id, projectId: id, environmentId: id });

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>;
