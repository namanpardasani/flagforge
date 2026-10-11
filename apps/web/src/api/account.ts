import { z } from "zod";
import { ApiError, request } from "./client";
import { getSession, markEmailVerified } from "./session";

/** Account recovery and email confirmation. None of these (except resend) needs a signed-in user. */

const verified = z.object({ verified: z.literal(true) });
const resent = z.object({ alreadyVerified: z.boolean() });
const accepted = z.object({ message: z.string() });
const resetDone = z.object({ reset: z.literal(true) });

// A confirmation link works once. React's development mode runs effects twice, which would spend
// the link on the first call and show an error after a success. One request per token, shared.
const verifying = new Map<string, Promise<void>>();

/** Opens a confirmation link. Resolves when the address is confirmed; rejects with the server's reason. */
export function verifyEmail(token: string): Promise<void> {
  let attempt = verifying.get(token);
  if (!attempt) {
    attempt = request("POST", "/auth/verify-email", { body: { token }, schema: verified, authenticated: false }).then(() => {
      if (getSession().status === "signedIn") markEmailVerified();
    });
    verifying.set(token, attempt);
    // A failed attempt may be retried (the person might try again); a successful one must not run twice.
    attempt.catch(() => verifying.delete(token));
  }
  return attempt;
}

export const resendVerification = (): Promise<{ alreadyVerified: boolean }> => request("POST", "/auth/resend-verification", { schema: resent });

/** The server answers the same for every address, so this never says whether an account exists. */
export const forgotPassword = async (email: string): Promise<string> => (await request("POST", "/auth/forgot-password", { body: { email }, schema: accepted, authenticated: false })).message;

export const resetPassword = async (token: string, password: string): Promise<void> => {
  await request("POST", "/auth/reset-password", { body: { token, password }, schema: resetDone, authenticated: false });
};

/** Why a link did not work, in words for a person. */
export function explainLinkError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "INVALID_TOKEN") return "This link is invalid, has expired, or was already used.";
    if (error.status === 429) return "Too many attempts. Wait a few minutes and try again.";
    if (error.isOffline) return error.message;
    if (error.status >= 500) return "The server had a problem. Try again in a moment.";
    return error.message;
  }
  return "Something went wrong. Try again.";
}
