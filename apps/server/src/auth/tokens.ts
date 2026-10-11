import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";

export function signAccessToken(config: Config, userId: string): string {
  return jwt.sign({}, config.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    subject: userId,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
  });
}

/** Returns who a valid access token belongs to and when it stops being valid, or throws a 401. */
export function readAccessToken(config: Config, token: string): { userId: string; expiresAt: number } {
  try {
    // Pinning the algorithm stops "alg: none" and algorithm-swap attacks.
    const payload = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
    if (typeof payload === "string" || !payload.sub || typeof payload.exp !== "number") throw new Error("no subject");
    return { userId: payload.sub, expiresAt: payload.exp * 1000 };
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid or expired access token");
  }
}

/** Returns the user id from a valid access token, or throws a 401. */
export function verifyAccessToken(config: Config, token: string): string {
  return readAccessToken(config, token).userId;
}

/** A random opaque token. Only its hash is stored, so a DB leak does not leak usable tokens. */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
