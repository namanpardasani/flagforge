import { randomBytes } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { writeAudit } from "../audit.js";
import { hashToken } from "../auth/tokens.js";
import { keyTopic, publishQuietly, type EventBus } from "../realtime/bus.js";
import type { KeyCache } from "../redis/key-cache.js";
import { AppError } from "../errors.js";

export const API_KEY_PREFIX = "ff_";

const publicSelect = { id: true, name: true, prefix: true, createdAt: true, revokedAt: true } as const;

/**
 * Keys are 192 random bits, so a plain SHA-256 is enough (unlike passwords, they cannot be guessed).
 * Only the hash is stored; the full key is returned exactly once, when it is created.
 */
export function generateApiKey() {
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { key, keyHash: hashToken(key), prefix: key.slice(0, 10) };
}

export function createApiKeyService(prisma: PrismaClient, bus: EventBus, keyCache: KeyCache) {
  /** The environment must belong to this project AND workspace, otherwise it does not exist. */
  async function requireEnvironment(workspaceId: string, projectId: string, environmentId: string) {
    const environment = await prisma.environment.findFirst({
      where: { id: environmentId, projectId, workspaceId },
      select: { id: true, key: true },
    });
    if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");
    return environment;
  }

  return {
    async create(workspaceId: string, projectId: string, environmentId: string, actorId: string, name: string) {
      const environment = await requireEnvironment(workspaceId, projectId, environmentId);
      const { key, keyHash, prefix } = generateApiKey();
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.apiKey.create({
          data: { workspaceId, environmentId, name, keyHash, prefix, createdById: actorId },
          select: publicSelect,
        });
        await writeAudit(tx, {
          workspaceId,
          actorId,
          action: "apikey.created",
          entityType: "api_key",
          entityId: row.id,
          metadata: { name, prefix, environmentId, environmentKey: environment.key },
        });
        return row;
      });
      return { ...created, key }; // the only time the full key is ever returned
    },

    async list(workspaceId: string, projectId: string, environmentId: string) {
      await requireEnvironment(workspaceId, projectId, environmentId);
      return prisma.apiKey.findMany({
        where: { workspaceId, environmentId },
        select: publicSelect,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    },

    async revoke(workspaceId: string, projectId: string, environmentId: string, actorId: string, apiKeyId: string) {
      const environment = await requireEnvironment(workspaceId, projectId, environmentId);
      const existing = await prisma.apiKey.findFirst({
        where: { id: apiKeyId, environmentId, workspaceId },
        select: { keyHash: true, name: true, prefix: true },
      });
      await prisma.$transaction(async (tx) => {
        // revokedAt: null in the filter makes this atomic and idempotent-safe: a second revoke is a 404.
        const { count } = await tx.apiKey.updateMany({
          where: { id: apiKeyId, environmentId, workspaceId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (count === 0) throw new AppError(404, "API_KEY_NOT_FOUND", "API key not found");
        await writeAudit(tx, {
          workspaceId,
          actorId,
          action: "apikey.revoked",
          entityType: "api_key",
          entityId: apiKeyId,
          // Name and prefix are recorded so the log can say WHICH key, even though the key row stays hidden.
          metadata: { environmentId, environmentKey: environment.key, ...(existing ? { name: existing.name, prefix: existing.prefix } : {}) },
        });
      });
      // Revocation must be immediate: forget the key everywhere BEFORE anything else can use the cached copy.
      if (existing) await keyCache.invalidate([existing.keyHash]);
      // Close any open streams that were using this key right away (after the revoke is committed).
      await publishQuietly(bus, keyTopic(apiKeyId), { type: "key_revoked", apiKeyId });
    },
  };
}

export type ApiKeyService = ReturnType<typeof createApiKeyService>;
