import "server-only";
import type { ProjectRole } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { forbidden, notFound } from "@/lib/api/errors";

/** The owner isn't a member row; OWNER ranks above every ProjectRole. */
export type AccessRole = "OWNER" | ProjectRole;
const RANK: Record<AccessRole, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 };

export const projectNotFound = () => notFound("PROJECT_NOT_FOUND", "Project not found.");

export function atLeast(role: AccessRole | null, minimum: AccessRole): boolean {
  return role !== null && RANK[role] >= RANK[minimum];
}

export const projectInclude = (userId: string) => ({
  owner: { select: { id: true, username: true } },
  defaultBranch: { select: { name: true } },
  members: { where: { userId }, select: { role: true } },
});

/**
 * The project plus the caller's role: OWNER, a member role, or null for a non-member
 * reading a public project. Private projects are a 404 to outsiders so ids and slugs don't leak.
 */
export async function loadProjectAccess(userId: string, projectId: string) {
  const project = await getDb().project.findUnique({ where: { id: projectId }, include: projectInclude(userId) });
  if (!project) throw projectNotFound();
  const role: AccessRole | null = project.ownerId === userId ? "OWNER" : project.members[0]?.role ?? null;
  if (!role && project.visibility === "PRIVATE") throw projectNotFound();
  return { project, role };
}

/** Load the project and require at least `minimum`. "READ" admits anyone who can see it. */
export async function requireProjectRole(userId: string, projectId: string, minimum: AccessRole | "READ") {
  const access = await loadProjectAccess(userId, projectId);
  if (minimum !== "READ" && !atLeast(access.role, minimum)) throw forbidden();
  return access;
}
