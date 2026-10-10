import bcrypt from "bcrypt";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import type { LoginInput, RegisterInput } from "./schemas.js";
import { generateRefreshToken, hashToken, signAccessToken } from "./tokens.js";

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

const publicUserSelect = { id: true, email: true, name: true, createdAt: true } as const;

export function createAuthService(prisma: PrismaClient, config: Config) {
  // Compared against when the email is unknown, so login takes the same time either way.
  const dummyHash = bcrypt.hashSync("not-a-real-password", config.BCRYPT_ROUNDS);

  async function issueTokens(userId: string) {
    const { token, tokenHash } = generateRefreshToken();
    const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({ data: { userId, tokenHash, expiresAt } });
    return { accessToken: signAccessToken(config, userId), refreshToken: token };
  }

  return {
    async register(input: RegisterInput): Promise<AuthResult> {
      const existing = await prisma.user.findUnique({ where: { email: input.email } });
      if (existing) throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");

      const passwordHash = await bcrypt.hash(input.password, config.BCRYPT_ROUNDS);
      let user: PublicUser;
      try {
        user = await prisma.user.create({
          data: { email: input.email, passwordHash, name: input.name },
          select: publicUserSelect,
        });
      } catch (err) {
        // Two simultaneous registrations can both pass the check above; the unique index catches it.
        if ((err as { code?: string }).code === "P2002") {
          throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
        }
        throw err;
      }
      return { user, ...(await issueTokens(user.id)) };
    },

    async login(input: LoginInput): Promise<AuthResult> {
      const user = await prisma.user.findUnique({ where: { email: input.email } });
      const valid = await bcrypt.compare(input.password, user?.passwordHash ?? dummyHash);
      if (!user || !valid) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");

      const { passwordHash: _omit, ...publicUser } = user;
      return { user: publicUser, ...(await issueTokens(user.id)) };
    },

    /** Rotation: each refresh token works once. Reusing an old one revokes the whole session set. */
    async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
      const tokenHash = hashToken(refreshToken);
      const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
      if (!stored) throw new AppError(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token");

      const now = new Date();
      // updateMany with revokedAt: null makes the claim atomic: only one concurrent caller wins.
      const claimed = await prisma.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });
      if (claimed.count === 0) {
        if (stored.revokedAt) {
          await prisma.refreshToken.updateMany({
            where: { userId: stored.userId, revokedAt: null },
            data: { revokedAt: now },
          });
        }
        throw new AppError(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token");
      }
      return issueTokens(stored.userId);
    },

    /** Idempotent: unknown or already-revoked tokens are silently accepted. */
    async logout(refreshToken: string): Promise<void> {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },

    async getUser(userId: string): Promise<PublicUser> {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: publicUserSelect });
      if (!user) throw new AppError(401, "UNAUTHORIZED", "Invalid or expired access token");
      return user;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
