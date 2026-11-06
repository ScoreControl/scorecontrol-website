import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Shared Prisma client for the app's tables. Connects as the table owner through DATABASE_URL
 * (the transaction pooler), so RLS does not apply: every query must be scoped by the caller's
 * verified user id and project role (requireUser / requireProjectRole).
 */
function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Reuse one client across hot reloads in development instead of opening a new pool each time.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function getDb(): PrismaClient {
  return globalForPrisma.prisma ??= createClient();
}
