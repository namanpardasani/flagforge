import bcrypt from "bcrypt";
import type { Logger } from "pino";
import type { EmailTokenKind, PrismaClient } from "../../generated/prisma/client.js";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import type { Mailer } from "../mail/mailer.js";
import { passwordChangedMail, resetPasswordMail, verifyEmailMail } from "../mail/templates.js";
import type { LoginInput, RegisterInput } from "./schemas.js";
import { generateRefreshToken, hashToken, signAccessToken } from "./tokens.js";

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  /** True once the person has proven they own the address. */
  emailVerified: boolean;
}

/** How long an emailed link works. Short for a reset (it unlocks the account), longer for confirming an address. */
export const VERIFY_TTL_HOURS = 24;
export const RESET_TTL_MINUTES = 60;

interface UserRow {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  emailVerifiedAt: Date | null;
}
const toPublic = (user: UserRow): PublicUser => ({ id: user.id, email: user.email, name: user.name, createdAt: user.createdAt, emailVerified: user.emailVerifiedAt !== null });

const invalidToken = () => new AppError(400, "INVALID_TOKEN", "This link is invalid, has expired, or was already used");

export interface AuthDeps {
  mailer: Mailer;
  logger: Logger;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

const publicUserSelect = { id: true, email: true, name: true, createdAt: true, emailVerifiedAt: true } as const;

export function createAuthService(prisma: PrismaClient, config: Config, { mailer, logger }: AuthDeps) {
  // Compared against when the email is unknown, so login takes the same time either way.
  const dummyHash = bcrypt.hashSync("not-a-real-password", config.BCRYPT_ROUNDS);

  async function issueTokens(userId: string) {
    const { token, tokenHash } = generateRefreshToken();
    const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({ data: { userId, tokenHash, expiresAt } });
    return { accessToken: signAccessToken(config, userId), refreshToken: token };
  }

  // Emails are sent in the background: a slow or broken mail provider must never make registration,
  // or "forgot password", slow or fail, and (for forgot password) a different speed for known and
  // unknown addresses would reveal which accounts exist. Failures are logged without the message.
  const pending = new Set<Promise<void>>();
  function inBackground(task: () => Promise<void>, what: string) {
    const run = task().catch((err: unknown) => logger.error({ err: err instanceof Error ? err.message : "unknown", what }, "email could not be sent"));
    pending.add(run);
    void run.finally(() => pending.delete(run));
  }

  /** Makes a fresh single-use token. Older unused tokens of the same kind stop working. */
  async function createEmailToken(userId: string, kind: EmailTokenKind, ttlMs: number): Promise<string> {
    const { token, tokenHash } = generateRefreshToken(); // 256 random bits, stored only as a hash
    await prisma.$transaction([
      prisma.emailToken.updateMany({ where: { userId, kind, usedAt: null }, data: { usedAt: new Date() } }),
      prisma.emailToken.create({ data: { userId, kind, tokenHash, expiresAt: new Date(Date.now() + ttlMs) } }),
    ]);
    return token;
  }

  /** The link goes to the dashboard. The token is in the URL FRAGMENT (after #), which browsers never send to any server and never put in a Referer header. */
  const link = (path: string, token: string) => `${config.APP_URL.replace(/\/+$/, "")}${path}#token=${token}`;

  async function sendVerification(user: { id: string; email: string; name: string }) {
    const token = await createEmailToken(user.id, "VERIFY_EMAIL", VERIFY_TTL_HOURS * 3_600_000);
    await mailer.send(verifyEmailMail(user.email, user.name, link("/verify-email", token), VERIFY_TTL_HOURS));
  }

  return {
    /** Resolves when every email queued so far has been attempted. For tests and graceful shutdown. */
    async idle(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },

    async register(input: RegisterInput): Promise<AuthResult> {
      const existing = await prisma.user.findUnique({ where: { email: input.email } });
      if (existing) throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");

      const passwordHash = await bcrypt.hash(input.password, config.BCRYPT_ROUNDS);
      let user: UserRow;
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
      inBackground(() => sendVerification(user), "verification");
      return { user: toPublic(user), ...(await issueTokens(user.id)) };
    },

    async login(input: LoginInput): Promise<AuthResult> {
      const user = await prisma.user.findUnique({ where: { email: input.email } });
      const valid = await bcrypt.compare(input.password, user?.passwordHash ?? dummyHash);
      if (!user || !valid) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");

      return { user: toPublic(user), ...(await issueTokens(user.id)) };
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
      return toPublic(user);
    },

    // ---- email verification ----------------------------------------------------------------

    /** Opening the emailed link. Works once, before it expires. */
    async verifyEmail(token: string): Promise<{ verified: true }> {
      const now = new Date();
      const stored = await prisma.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
      if (!stored || stored.kind !== "VERIFY_EMAIL") throw invalidToken();
      await prisma.$transaction(async (tx) => {
        // updateMany with usedAt: null makes the claim atomic: two clicks at once, only one wins.
        const claimed = await tx.emailToken.updateMany({ where: { id: stored.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
        if (claimed.count === 0) throw invalidToken();
        await tx.user.updateMany({ where: { id: stored.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
      });
      return { verified: true };
    },

    /** "Send it again". Silent success when already confirmed, so the answer reveals nothing new. */
    async resendVerification(userId: string): Promise<{ alreadyVerified: boolean }> {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, emailVerifiedAt: true } });
      if (!user) throw new AppError(401, "UNAUTHORIZED", "Invalid or expired access token");
      if (user.emailVerifiedAt) return { alreadyVerified: true };
      inBackground(() => sendVerification(user), "verification");
      return { alreadyVerified: false };
    },

    // ---- password reset --------------------------------------------------------------------

    /**
     * Always looks the same from outside: the caller learns nothing about whether the address has
     * an account. The lookup and the email run in the background so timing does not tell either.
     */
    async forgotPassword(email: string): Promise<void> {
      inBackground(async () => {
        const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
        if (!user) return;
        const token = await createEmailToken(user.id, "RESET_PASSWORD", RESET_TTL_MINUTES * 60_000);
        await mailer.send(resetPasswordMail(user.email, link("/reset-password", token), RESET_TTL_MINUTES));
      }, "password reset");
    },

    /**
     * Sets a new password with an emailed token. Afterwards every session is signed out (whoever
     * had the old password, or a stolen session, loses access) and the address counts as confirmed:
     * receiving this email proves it is theirs.
     */
    async resetPassword(token: string, newPassword: string): Promise<{ reset: true }> {
      const now = new Date();
      const stored = await prisma.emailToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { select: { email: true } } } });
      if (!stored || stored.kind !== "RESET_PASSWORD" || stored.usedAt || stored.expiresAt <= now) throw invalidToken();
      // Hashing is slow on purpose, so it is done only for a token that looked valid.
      const passwordHash = await bcrypt.hash(newPassword, config.BCRYPT_ROUNDS);
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.emailToken.updateMany({ where: { id: stored.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
        if (claimed.count === 0) throw invalidToken();
        await tx.user.update({ where: { id: stored.userId }, data: { passwordHash } });
        await tx.user.updateMany({ where: { id: stored.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
        await tx.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: now } });
        // Any other reset link still in an inbox is now useless too.
        await tx.emailToken.updateMany({ where: { userId: stored.userId, kind: "RESET_PASSWORD", usedAt: null }, data: { usedAt: now } });
      });
      inBackground(() => mailer.send(passwordChangedMail(stored.user.email)), "password changed notice");
      return { reset: true };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
