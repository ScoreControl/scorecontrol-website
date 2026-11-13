import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { PROJECT_ROLES, projectIdSchema, type ProjectRole } from "./contract";
import { forbidden, notFound } from "./errors";

export type ProjectAccess = {
  project: { id: string; ownerId: string; defaultBranchId: string | null };
  role: ProjectRole;
};

export const hasRole = (role: ProjectRole, minRole: ProjectRole) =>
  PROJECT_ROLES.indexOf(role) >= PROJECT_ROLES.indexOf(minRole);

/**
 * The caller's access to a project, or null when they have none. The owner (projects.owner_id) is
 * "owner"; members get their project_members role. Archived projects count as gone.
 */
export async function getProjectAccess(userId: string, projectId: string,
  db: Pick<PrismaClient, "project"> = getDb()): Promise<ProjectAccess | null> {
  if (!projectIdSchema.safeParse(projectId).success) return null;
  const project = await db.project.findFirst({
    where: { id: projectId, archivedAt: null },
    select: { id: true, ownerId: true, defaultBranchId: true, members: { where: { userId }, select: { role: true } } },
  });
  if (!project) return null;
  const { members, ...rest } = project;
  if (project.ownerId === userId) return { project: rest, role: "owner" };
  const membership = members[0];
  return membership ? { project: rest, role: membership.role.toLowerCase() as ProjectRole } : null;
}

/**
 * Use at the top of every project route, with the user id from withApiRoute. Non-members get
 * 404 NOT_FOUND (indistinguishable from a missing project); members below `minRole` get 403 FORBIDDEN.
 */
export async function requireProjectRole(userId: string, projectId: string, minRole: ProjectRole,
  db?: Pick<PrismaClient, "project">): Promise<ProjectAccess> {
  const access = await getProjectAccess(userId, projectId, db);
  if (!access) throw notFound();
  if (!hasRole(access.role, minRole)) throw forbidden();
  return access;
}
