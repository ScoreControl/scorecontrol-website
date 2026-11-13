import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Shared Prisma client over node-postgres. Connects as the database owner, so it bypasses RLS:
 * every caller must authorize first (see src/lib/projects/access.ts).
 * Created lazily so `next build` works without DATABASE_URL, and cached on globalThis so
 * dev-server hot reloads don't open a new pool each time.
 */
const cache = globalThis as unknown as { scorecontrolDb?: PrismaClient };

export function getDb(): PrismaClient {
  if (cache.scorecontrolDb) return cache.scorecontrolDb;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");
  cache.scorecontrolDb = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return cache.scorecontrolDb;
}

/** Postgres unique-violation as reported by Prisma. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}
