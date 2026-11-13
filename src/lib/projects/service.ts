import "server-only";
import type { z } from "zod";
import { getDb, isUniqueViolation } from "@/lib/db";
import { conflict, forbidden, notFound } from "@/lib/api/errors";
import { atLeast, loadProjectAccess, projectInclude, projectNotFound, requireProjectRole, type AccessRole } from "./access";
import { slugify, type addMemberSchema, type createProjectSchema, type updateMemberSchema, type updateProjectSchema } from "./validation";

const DEFAULT_BRANCH = "main";
const slugTaken = () => conflict("SLUG_TAKEN", "You already have a project with that URL name.");

type ProjectRow = Awaited<ReturnType<typeof loadProjectAccess>>["project"];

export function toProjectDto(project: ProjectRow, role: AccessRole | null) {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    visibility: project.visibility,
    owner: project.owner,
    defaultBranch: project.defaultBranch?.name ?? null,
    role,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt,
  };
}

const roleOf = (project: ProjectRow, userId: string): AccessRole | null =>
  project.ownerId === userId ? "OWNER" : project.members[0]?.role ?? null;

/** Projects the user owns or is a member of, most recently updated first. */
export async function listProjects(userId: string, { includeArchived = false } = {}) {
  const projects = await getDb().project.findMany({
    where: {
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      ...(includeArchived ? {} : { archivedAt: null }),
    },
    include: projectInclude(userId),
    orderBy: { updatedAt: "desc" },
  });
  return projects.map((project) => toProjectDto(project, roleOf(project, userId)));
}

/** Creates the project and its empty default branch in one transaction. */
export async function createProject(userId: string, input: z.output<typeof createProjectSchema>) {
  const db = getDb();
  // users rows exist only once an account has a username (users_sync_triggers).
  if (!(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) {
    throw forbidden("USERNAME_REQUIRED", "Choose a username before creating projects.");
  }
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw conflict("SLUG_REQUIRED", "Choose a URL name for this project.");
  try {
    const project = await db.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: { ownerId: userId, slug, name: input.name, description: input.description ?? null, visibility: input.visibility ?? "PRIVATE" },
      });
      const branch = await tx.branch.create({ data: { projectId: created.id, name: DEFAULT_BRANCH, createdById: userId } });
      return tx.project.update({ where: { id: created.id }, data: { defaultBranchId: branch.id }, include: projectInclude(userId) });
    });
    return toProjectDto(project, "OWNER");
  } catch (error) {
    if (isUniqueViolation(error)) throw slugTaken();
    throw error;
  }
}

export async function getProject(userId: string, projectId: string) {
  const { project, role } = await loadProjectAccess(userId, projectId);
  return toProjectDto(project, role);
}

/** Resolves /{username}/{slug} URLs. */
export async function findProjectBySlug(userId: string, ownerUsername: string, slug: string) {
  const row = await getDb().project.findFirst({ where: { slug, owner: { username: ownerUsername } }, select: { id: true } });
  if (!row) throw projectNotFound();
  return getProject(userId, row.id);
}

/** Owners and admins edit settings. */
export async function updateProject(userId: string, projectId: string, input: z.output<typeof updateProjectSchema>) {
  const { role } = await requireProjectRole(userId, projectId, "ADMIN");
  const { archived, ...fields } = input;
  try {
    const project = await getDb().project.update({
      where: { id: projectId },
      data: { ...fields, ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }) },
      include: projectInclude(userId),
    });
    return toProjectDto(project, role);
  } catch (error) {
    if (isUniqueViolation(error)) throw slugTaken();
    throw error;
  }
}

/** Only the owner deletes. History, branches, and blob rows go with it. */
export async function deleteProject(userId: string, projectId: string) {
  await requireProjectRole(userId, projectId, "OWNER");
  await getDb().project.delete({ where: { id: projectId } });
}

// ─── Members ────────────────────────────────────────────────────────────────

const memberSelect = {
  role: true,
  createdAt: true,
  user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
} as const;
const memberNotFound = () => notFound("MEMBER_NOT_FOUND", "That user isn't a member of this project.");
const ownerOnly = () => forbidden("OWNER_REQUIRED", "Only the project owner can manage admins.");
const memberKey = (projectId: string, userId: string) => ({ projectId_userId: { projectId, userId } });

export async function listMembers(userId: string, projectId: string) {
  const { project } = await requireProjectRole(userId, projectId, "READ");
  const members = await getDb().projectMember.findMany({ where: { projectId }, select: memberSelect, orderBy: { createdAt: "asc" } });
  return { owner: project.owner, members };
}

/** Admins add editors and viewers; only the owner adds admins. */
export async function addMember(userId: string, projectId: string, input: z.output<typeof addMemberSchema>) {
  const { project, role } = await requireProjectRole(userId, projectId, "ADMIN");
  if (input.role === "ADMIN" && role !== "OWNER") throw ownerOnly();
  const db = getDb();
  const target = await db.user.findUnique({ where: { username: input.username }, select: { id: true } });
  if (!target) throw notFound("USER_NOT_FOUND", "No user has that username.");
  if (target.id === project.ownerId) throw conflict("ALREADY_OWNER", "That user owns this project.");
  try {
    return await db.projectMember.create({
      data: { projectId, userId: target.id, role: input.role, invitedById: userId }, select: memberSelect,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("ALREADY_MEMBER", "That user is already a member.");
    throw error;
  }
}

/** Admins change editor and viewer roles; changes to or from ADMIN need the owner. */
export async function updateMember(userId: string, projectId: string, memberId: string, input: z.output<typeof updateMemberSchema>) {
  const { role } = await requireProjectRole(userId, projectId, "ADMIN");
  const db = getDb();
  const current = await db.projectMember.findUnique({ where: memberKey(projectId, memberId), select: { role: true } });
  if (!current) throw memberNotFound();
  if ((current.role === "ADMIN" || input.role === "ADMIN") && role !== "OWNER") throw ownerOnly();
  return db.projectMember.update({ where: memberKey(projectId, memberId), data: { role: input.role }, select: memberSelect });
}

/** Any member can leave. Otherwise admins remove editors and viewers; only the owner removes admins. */
export async function removeMember(userId: string, projectId: string, memberId: string) {
  const { role } = await loadProjectAccess(userId, projectId);
  const db = getDb();
  if (memberId !== userId && !atLeast(role, "ADMIN")) throw forbidden();
  const current = await db.projectMember.findUnique({ where: memberKey(projectId, memberId), select: { role: true } });
  if (!current) throw memberNotFound();
  if (memberId !== userId && current.role === "ADMIN" && role !== "OWNER") throw ownerOnly();
  await db.projectMember.delete({ where: memberKey(projectId, memberId) });
}
