import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { apiError, notFound } from "@/lib/api/errors";
import { requireProjectRole } from "@/lib/api/roles";
import {
  DEFAULT_BRANCH, type Branch, type CreateProjectResponse, type GetProjectResponse, type ListBranchesResponse,
  type ListProjectsResponse, type Project, type ProjectRole, type createBranchRequestSchema, type createProjectRequestSchema,
} from "@/lib/api/contract";
import type { z } from "zod";

// Section 5 of docs/api-contract.md: projects and branches.

type Db = PrismaClient;
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "P2002";

const branchSelect = {
  name: true, archivedAt: true,
  headCommit: { select: { hash: true, message: true } },
} as const;
type BranchRow = { name: string; archivedAt: Date | null; headCommit: { hash: string; message: string } | null };

export function toBranch(row: BranchRow): Branch {
  return { name: row.name, headHash: row.headCommit?.hash ?? null, headMessage: row.headCommit?.message ?? null, archived: row.archivedAt !== null };
}

type ProjectRow = { id: string; name: string; slug: string; description: string | null; createdAt: Date; defaultBranch: { name: string } | null };

function toProject(row: ProjectRow, role: ProjectRole): Project {
  return {
    id: row.id, name: row.name, slug: row.slug, description: row.description, role,
    defaultBranch: row.defaultBranch?.name ?? DEFAULT_BRANCH, createdAt: row.createdAt.toISOString(),
  };
}

/** "Sonata in D" -> "sonata-in-d". Falls back to "project" when nothing usable remains. */
export function slugify(name: string): string {
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return slug || "project";
}

/** The base slug if free, else base-2, base-3, ... (unique per owner). */
async function freeSlug(db: Db, ownerId: string, base: string): Promise<string> {
  const taken = new Set((await db.project.findMany({
    where: { ownerId, slug: { startsWith: base } }, select: { slug: true },
  })).map((p) => p.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Creates the project and its empty default branch in one transaction. */
export async function createProject(userId: string, input: z.output<typeof createProjectRequestSchema>, db: Db = getDb()): Promise<CreateProjectResponse> {
  // users rows exist only once the account has a username (users_sync_triggers).
  if (!(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) {
    throw apiError("VALIDATION_FAILED", "Choose a username before creating projects.");
  }
  // `format` is accepted per the contract; projects don't store it yet (blobs carry their own format).
  const base = slugify(input.name);
  for (let attempt = 0; ; attempt++) {
    const slug = await freeSlug(db, userId, base);
    try {
      return await db.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: { ownerId: userId, slug, name: input.name, description: input.description ?? null },
        });
        const branch = await tx.branch.create({ data: { projectId: project.id, name: DEFAULT_BRANCH, createdById: userId }, select: branchSelect });
        const updated = await tx.project.update({
          where: { id: project.id }, data: { defaultBranch: { connect: { projectId_name: { projectId: project.id, name: DEFAULT_BRANCH } } } },
          include: { defaultBranch: { select: { name: true } } },
        });
        return { project: toProject(updated, "owner"), branch: toBranch(branch) };
      });
    } catch (error) {
      // Another request took the same slug between the check and the insert: pick again.
      if (isUniqueViolation(error) && attempt < 3) continue;
      throw error;
    }
  }
}

const roleOf = (ownerId: string, userId: string, members: { role: string }[]): ProjectRole =>
  ownerId === userId ? "owner" : (members[0].role.toLowerCase() as ProjectRole);

/** Projects the caller owns or belongs to, newest activity first, each with its default branch as `head`. */
export async function listProjects(userId: string, db: Db = getDb()): Promise<ListProjectsResponse> {
  const rows = await db.project.findMany({
    where: { archivedAt: null, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    include: {
      defaultBranch: { select: branchSelect },
      members: { where: { userId }, select: { role: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  return {
    projects: rows.map((row) => ({
      ...toProject(row, roleOf(row.ownerId, userId, row.members)),
      head: row.defaultBranch ? toBranch(row.defaultBranch) : { name: DEFAULT_BRANCH, headHash: null, headMessage: null, archived: false },
    })),
  };
}

async function branchRows(db: Db, projectId: string, includeArchived: boolean) {
  return db.branch.findMany({
    where: { projectId, ...(includeArchived ? {} : { archivedAt: null }) },
    select: branchSelect, orderBy: { name: "asc" },
  });
}

/** Viewer and up. Lists active branches. */
export async function getProject(userId: string, projectId: string, db: Db = getDb()): Promise<GetProjectResponse> {
  const { role } = await requireProjectRole(userId, projectId, "viewer", db);
  const row = await db.project.findUniqueOrThrow({ where: { id: projectId }, include: { defaultBranch: { select: { name: true } } } });
  return { project: toProject(row, role), branches: (await branchRows(db, projectId, false)).map(toBranch) };
}

export async function listBranches(userId: string, projectId: string, includeArchived: boolean, db: Db = getDb()): Promise<ListBranchesResponse> {
  await requireProjectRole(userId, projectId, "viewer", db);
  return { branches: (await branchRows(db, projectId, includeArchived)).map(toBranch) };
}

/** Full hash or a unique prefix of 7+ characters -> commit id. */
export async function resolveCommit(db: Db, projectId: string, hashRef: string) {
  const matches = await db.commit.findMany({ where: { projectId, hash: { startsWith: hashRef } }, select: { id: true, hash: true }, take: 2 });
  if (matches.length === 0) throw notFound("Commit");
  if (matches.length > 1) throw apiError("AMBIGUOUS_HASH", "That hash prefix matches more than one commit. Use more characters.");
  return matches[0];
}

/** Editor and up. Creates a branch pointing at an existing commit. */
export async function createBranch(userId: string, projectId: string, input: z.output<typeof createBranchRequestSchema>, db: Db = getDb()): Promise<{ branch: Branch }> {
  await requireProjectRole(userId, projectId, "editor", db);
  const commit = await resolveCommit(db, projectId, input.fromHash);
  try {
    const branch = await db.branch.create({
      data: { projectId, name: input.name, headCommitId: commit.id, createdById: userId }, select: branchSelect,
    });
    return { branch: toBranch(branch) };
  } catch (error) {
    if (isUniqueViolation(error)) throw apiError("BRANCH_EXISTS", `A branch named ${input.name} already exists.`);
    throw error;
  }
}

/** Admin and up. The default branch can't be archived. */
export async function setBranchArchived(userId: string, projectId: string, name: string, archived: boolean, db: Db = getDb()): Promise<{ branch: Branch }> {
  const { project } = await requireProjectRole(userId, projectId, "admin", db);
  const existing = await db.branch.findUnique({ where: { projectId_name: { projectId, name } }, select: { id: true, archivedAt: true } });
  if (!existing) throw notFound("Branch");
  if (archived && existing.id === project.defaultBranchId) throw apiError("VALIDATION_FAILED", "The default branch can't be archived.");
  const branch = await db.branch.update({
    where: { id: existing.id },
    // Keep the original timestamp when archiving twice.
    data: { archivedAt: archived ? existing.archivedAt ?? new Date() : null },
    select: branchSelect,
  });
  return { branch: toBranch(branch) };
}
