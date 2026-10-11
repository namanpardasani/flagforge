import type { RequestHandler } from "express";
import { readAccessToken } from "../auth/tokens.js";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth. Only the user id comes from the token; look up anything else in the DB. */
      userId?: string;
      /** When the presented access token expires (ms since epoch). Long-lived responses must not outlive it. */
      tokenExpiresAt?: number;
    }
  }
}

export function requireAuth(config: Config): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    const match = header?.match(/^Bearer (.+)$/);
    if (!match?.[1]) throw new AppError(401, "UNAUTHORIZED", "Missing bearer token");
    const token = readAccessToken(config, match[1]);
    req.userId = token.userId;
    req.tokenExpiresAt = token.expiresAt;
    next();
  };
}
