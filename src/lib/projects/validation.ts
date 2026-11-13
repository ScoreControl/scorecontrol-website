import "server-only";
import { z } from "zod";
import { usernameSchema } from "@/lib/auth/validation";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const slugSchema = z.string().trim().toLowerCase()
  .regex(SLUG, "Use 1-64 lowercase letters, digits, or hyphens, starting and ending with a letter or digit.");
const nameSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().max(2000).nullable();
const visibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);
export const roleSchema = z.enum(["ADMIN", "EDITOR", "VIEWER"]);
export const uuidSchema = z.uuid();

/** "Symphony No. 1 in C minor" -> "symphony-no-1-in-c-minor". Empty if nothing usable remains. */
export function slugify(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
}

export const createProjectSchema = z.strictObject({
  name: nameSchema,
  slug: slugSchema.optional(),
  description: descriptionSchema.optional(),
  visibility: visibilitySchema.optional(),
});

export const updateProjectSchema = z.strictObject({
  name: nameSchema.optional(),
  slug: slugSchema.optional(),
  description: descriptionSchema.optional(),
  visibility: visibilitySchema.optional(),
  archived: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "Send at least one field to change.");

export const addMemberSchema = z.strictObject({ username: usernameSchema, role: roleSchema });
export const updateMemberSchema = z.strictObject({ role: roleSchema });
