import { z } from "zod";

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

// bcrypt only uses the first 72 bytes, so longer passwords would be silently truncated.
export const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 bytes");

export const registerSchema = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(100),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(200),
});

// Emailed tokens are 43 characters of base64url; the bounds just stop absurd input early.
const emailedToken = z.string().min(20).max(200);
export const verifyEmailSchema = z.object({ token: emailedToken }).strict();
export const forgotPasswordSchema = z.object({ email }).strict();
export const resetPasswordSchema = z.object({ token: emailedToken, password }).strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
