import "server-only";
import type { z } from "zod";
import type { PrismaClient, ProjectRole as DbRole } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { apiError, forbidden, notFound } from "@/lib/api/errors";
import { getProjectAccess, hasRole, requireProjectRole } from "@/lib/api/roles";
import type { ListMembersResponse, Member, MemberRole, addMemberRequestSchema, updateMemberRequestSchema } from "@/lib/api/contract";

// Project members. Rules: admins add, re-role, and remove editors and viewers; only the owner
// manages admins; any member can leave. The owner is never a member row.

type Db = PrismaClient;
const toDb = (role: MemberRole) => role.toUpperCase() as DbRole;
const ownerOnly = () => forbidden("Only the project owner can manage admins.");
const memberSelect = { role: true, createdAt: true, user: { select: { id: true, username: true } } } as const;
const toMember = (row: { role: DbRole; createdAt: Date; user: { id: string; username: string } }): Member =>
  ({ user: row.user, role: row.role.toLowerCase() as MemberRole, createdAt: row.createdAt.toISOString() });
const key = (projectId: string, userId: string) => ({ projectId_userId: { projectId, userId } });

/** Viewer and up. */
export async function listMembers(userId: string, projectId: string, db: Db = getDb()): Promise<ListMembersResponse> {
  const { project } = await requireProjectRole(userId, projectId, "viewer", db);
  const [owner, rows] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: project.ownerId }, select: { id: true, username: true } }),
    db.projectMember.findMany({ where: { projectId }, select: memberSelect, orderBy: { createdAt: "asc" } }),
  ]);
  return { owner, members: rows.map(toMember) };
}

export async function addMember(userId: string, projectId: string, input: z.output<typeof addMemberRequestSchema>, db: Db = getDb()): Promise<{ member: Member }> {
  const { project, role } = await requireProjectRole(userId, projectId, "admin", db);
  if (input.role === "admin" && role !== "owner") throw ownerOnly();
  const target = await db.user.findUnique({ where: { username: input.username }, select: { id: true } });
  if (!target) throw notFound("User");
  if (target.id === project.ownerId) throw apiError("VALIDATION_FAILED", "The owner already has full access.");
  try {
    const row = await db.projectMember.create({
      data: { projectId, userId: target.id, role: toDb(input.role), invitedById: userId }, select: memberSelect,
    });
    return { member: toMember(row) };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw apiError("MEMBER_EXISTS", "That user is already a member.");
    throw error;
  }
}

export async function updateMember(userId: string, projectId: string, memberId: string, input: z.output<typeof updateMemberRequestSchema>, db: Db = getDb()): Promise<{ member: Member }> {
  const { role } = await requireProjectRole(userId, projectId, "admin", db);
  const current = await db.projectMember.findUnique({ where: key(projectId, memberId), select: { role: true } });
  if (!current) throw notFound("Member");
  if ((current.role === "ADMIN" || input.role === "admin") && role !== "owner") throw ownerOnly();
  const row = await db.projectMember.update({ where: key(projectId, memberId), data: { role: toDb(input.role) }, select: memberSelect });
  return { member: toMember(row) };
}

/** Any member can remove themself; otherwise admin and up, and only the owner removes admins. */
export async function removeMember(userId: string, projectId: string, memberId: string, db: Db = getDb()): Promise<void> {
  const access = await getProjectAccess(userId, projectId, db);
  if (!access) throw notFound();
  const leaving = memberId === userId;
  if (!leaving && !hasRole(access.role, "admin")) throw forbidden();
  const current = await db.projectMember.findUnique({ where: key(projectId, memberId), select: { role: true } });
  if (!current) throw notFound("Member");
  if (!leaving && current.role === "ADMIN" && access.role !== "owner") throw ownerOnly();
  await db.projectMember.delete({ where: key(projectId, memberId) });
}
