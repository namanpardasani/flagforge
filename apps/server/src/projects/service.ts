import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../errors.js";
import type { KeyCache } from "../redis/key-cache.js";
import type { CreateEnvironmentInput, CreateProjectInput } from "./schemas.js";

const DEFAULT_ENVIRONMENTS = [
  { name: "Development", key: "dev" },
  { name: "Staging", key: "staging" },
  { name: "Production", key: "prod" },
] as const;

const environmentSelect = { id: true, name: true, key: true, createdAt: true } as const;
const projectNotFound = () => new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "P2002";

/**
 * Every query here is filtered by workspaceId. That is what keeps tenants apart, because
 * the database itself would accept an Environment whose project lives in another workspace.
 */
export function createProjectService(prisma: PrismaClient, keyCache: KeyCache) {
  /** Returns the project only if it belongs to this workspace; otherwise it "does not exist". */
  async function requireProject(workspaceId: string, projectId: string) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true, workspaceId: true },
    });
    if (!project) throw projectNotFound();
    return project;
  }

  return {
    async createProject(workspaceId: string, input: CreateProjectInput) {
      try {
        // Project and its default environments are created together or not at all.
        return await prisma.project.create({
          data: {
            workspaceId,
            name: input.name,
            key: input.key,
            environments: {
              create: DEFAULT_ENVIRONMENTS.map((e) => ({ workspaceId, name: e.name, key: e.key })),
            },
          },
          include: { environments: { select: environmentSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError(409, "PROJECT_KEY_TAKEN", "A project with this key already exists in the workspace");
        }
        throw err;
      }
    },

    listProjects(workspaceId: string) {
      return prisma.project.findMany({
        where: { workspaceId },
        include: { environments: { select: environmentSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
        orderBy: { createdAt: "asc" },
      });
    },

    async getProject(workspaceId: string, projectId: string) {
      const project = await prisma.project.findFirst({
        where: { id: projectId, workspaceId },
        include: { environments: { select: environmentSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
      });
      if (!project) throw projectNotFound();
      return project;
    },

    async deleteProject(workspaceId: string, projectId: string) {
      // The keys disappear with the project (cascade). Collect their hashes first so the key cache can forget them.
      const keys = await prisma.apiKey.findMany({
        where: { workspaceId, environment: { projectId } },
        select: { keyHash: true },
      });
      const { count } = await prisma.project.deleteMany({ where: { id: projectId, workspaceId } });
      if (count === 0) throw projectNotFound();
      await keyCache.invalidate(keys.map((k) => k.keyHash));
    },

    async createEnvironment(workspaceId: string, projectId: string, input: CreateEnvironmentInput) {
      const project = await requireProject(workspaceId, projectId);
      try {
        return await prisma.environment.create({
          // workspaceId is copied from the verified project, never taken from the client.
          data: { workspaceId: project.workspaceId, projectId: project.id, name: input.name, key: input.key },
          select: environmentSelect,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError(409, "ENVIRONMENT_KEY_TAKEN", "An environment with this key already exists in the project");
        }
        throw err;
      }
    },

    async listEnvironments(workspaceId: string, projectId: string) {
      await requireProject(workspaceId, projectId);
      return prisma.environment.findMany({
        where: { projectId, workspaceId },
        select: environmentSelect,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    },

    async deleteEnvironment(workspaceId: string, projectId: string, environmentId: string) {
      const keys = await prisma.apiKey.findMany({
        where: { workspaceId, environmentId, environment: { projectId } },
        select: { keyHash: true },
      });
      const { count } = await prisma.environment.deleteMany({
        where: { id: environmentId, projectId, workspaceId },
      });
      if (count === 0) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");
      await keyCache.invalidate(keys.map((k) => k.keyHash));
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;
