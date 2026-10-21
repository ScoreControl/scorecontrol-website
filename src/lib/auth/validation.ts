import "server-only";
import { z } from "zod";
import { AuthHttpError } from "./errors";

export const emailSchema = z.string().trim().max(320).pipe(z.email());
export const usernameSchema = z.string().trim().toLowerCase().min(1).max(39)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use letters, numbers, and single hyphens; start and end with a letter or number.")
  .refine((value) => !new Set(["admin", "api", "auth", "login", "logout", "signup", "settings", "support", "help", "www", "scorecontrol"]).has(value), "This username is reserved.");
const password = z.string().min(1).max(1024);
export const signupSchema = z.strictObject({ email: emailSchema, password: password.min(8), username: usernameSchema });
export const loginSchema = z.strictObject({
  identifier: z.string().trim().min(1).max(320).optional(),
  email: emailSchema.optional(),
  password,
  rememberMe: z.boolean().default(false),
}).superRefine((value, context) => {
  if (Boolean(value.identifier) === Boolean(value.email)) {
    context.addIssue({ code: "custom", path: ["identifier"], message: "Provide either identifier or email, but not both." });
  }
});
/** Resend-confirmation and forgot-password bodies. */
export const emailRequestSchema = z.strictObject({ email: emailSchema });
export const claimUsernameSchema = z.strictObject({ username: usernameSchema });
export const logoutSchema = z.strictObject({});
export const tokenHashSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/, "This link is invalid.");
export const resetPasswordSchema = z.strictObject({ tokenHash: tokenHashSchema, password: password.min(8) });
export const changePasswordSchema = z.strictObject({ password: password.min(8), currentPassword: password.optional() });

export function validate<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? "request");
      (fields[key] ??= []).push(issue.message);
    }
    throw new AuthHttpError(400, "INVALID_REQUEST", "Check the supplied fields.", fields);
  }
  return result.data;
}
