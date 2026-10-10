import type { RequestHandler } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { API_KEY_PREFIX } from "../apikeys/service.js";
import { hashToken } from "../auth/tokens.js";
import { AppError } from "../errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireApiKey: which environment (and tenant) the calling SDK belongs to. */
      sdk?: { apiKeyId: string; workspaceId: string; projectId: string; environmentId: string; environmentKey: string };
    }
  }
}

const invalid = () => new AppError(401, "INVALID_API_KEY", "Missing, invalid or revoked API key");

/** Authenticates server-side SDK calls. The key itself identifies the tenant and environment. */
export function requireApiKey(prisma: PrismaClient): RequestHandler {
  return async (req, _res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token?.startsWith(API_KEY_PREFIX)) throw invalid();

    const key = await prisma.apiKey.findUnique({
      where: { keyHash: hashToken(token) },
      select: {
        id: true,
        workspaceId: true,
        environmentId: true,
        revokedAt: true,
        environment: { select: { projectId: true, key: true } },
      },
    });
    if (!key || key.revokedAt) throw invalid();

    req.sdk = {
      apiKeyId: key.id,
      workspaceId: key.workspaceId,
      projectId: key.environment.projectId,
      environmentId: key.environmentId,
      environmentKey: key.environment.key,
    };
    next();
  };
}
