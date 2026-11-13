import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { downloadBlob } from "@/lib/storage";
import { apiError, notFound } from "@/lib/api/errors";
import { requireProjectRole } from "@/lib/api/roles";
import { AuthHttpError } from "@/lib/auth/errors";
import {
  DEFAULT_BRANCH, type Branch, type CreateProjectResponse, type GetProjectResponse, type ListBranchesResponse,
  type ListProjectsResponse, type Project, type CommitSummary, type CommitFile, type CommitDetailResponse, type HistoryResponse, SHORT_HASH_LENGTH, type historyQuerySchema, type ProjectRole, type SyncRelation, type SyncResponse,
  type createBranchRequestSchema, type createProjectRequestSchema, type syncQuerySchema,
} from "@/lib/api/contract";
import type { z } from "zod";

// Section 5 of docs/api-contract.md: projects and branches.

type Db = PrismaClient;
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "P2002";

export const branchSelect = {
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
export async function resolveCommit(db: Pick<Db, "commit">, projectId: string, hashRef: string) {
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

// ─── Sync (section 6) ───────────────────────────────────────────────────────

/**
 * Viewer and up. Compares the score's recorded commit with the branch head by walking the commit
 * graph in Postgres: `behind` when the local commit is an ancestor of the head, with `commitsAhead`
 * = commits reachable from the head but not from the local commit.
 */
export async function sync(userId: string, projectId: string, query: z.output<typeof syncQuerySchema>, db: Db = getDb()): Promise<SyncResponse> {
  const { role } = await requireProjectRole(userId, projectId, "viewer", db);
  const row = await db.branch.findUnique({
    where: { projectId_name: { projectId, name: query.branch } }, select: { ...branchSelect, headCommitId: true },
  });
  if (!row) throw notFound("Branch");
  const branches = (await branchRows(db, projectId, query.includeArchived)).map(toBranch);
  const answer = (relation: SyncRelation, commitsAhead = 0): SyncResponse => ({ branch: toBranch(row), relation, commitsAhead, branches, role });

  if (!query.commit) return answer("none");
  if (!row.headCommitId) return answer("empty");
  let local: { id: string };
  try {
    local = await resolveCommit(db, projectId, query.commit);
  } catch (error) {
    // A commit the project doesn't have still gets a usable answer.
    if (error instanceof AuthHttpError && error.code === "NOT_FOUND") return answer("unrelated");
    throw error;
  }
  if (local.id === row.headCommitId) return answer("same");
  const ahead = await commitsAhead(db, row.headCommitId, local.id);
  return ahead === null ? answer("unrelated") : answer("behind", ahead);
}

/**
 * How many commits the head is past `localId`: commits reachable from the head (through every
 * parent, so merges count) but not from `localId`. Null when `localId` isn't in the head's history.
 */
export async function commitsAhead(db: Pick<Db, "$queryRaw">, headId: string, localId: string): Promise<number | null> {
  const [{ is_ancestor, ahead }] = await db.$queryRaw<{ is_ancestor: boolean; ahead: number }[]>`
    WITH RECURSIVE
      from_head(id) AS (
        SELECT ${headId}::uuid
        UNION
        SELECT cp.parent_id FROM commit_parents cp JOIN from_head h ON cp.commit_id = h.id
      ),
      from_local(id) AS (
        SELECT ${localId}::uuid
        UNION
        SELECT cp.parent_id FROM commit_parents cp JOIN from_local l ON cp.commit_id = l.id
      )
    SELECT
      EXISTS (SELECT 1 FROM from_head WHERE id = ${localId}::uuid) AS is_ancestor,
      (SELECT count(*)::int FROM from_head WHERE id NOT IN (SELECT id FROM from_local)) AS ahead`;
  return is_ancestor ? ahead : null;
}

// ─── History (section 8) ────────────────────────────────────────────────────

export const summarySelect = {
  id: true, hash: true, message: true, createdAt: true,
  author: { select: { id: true, username: true } },
  parents: { select: { parent: { select: { hash: true } } }, orderBy: { position: "asc" } },
} as const;
type SummaryRow = {
  hash: string; message: string; createdAt: Date; author: { id: string; username: string } | null;
  parents: { parent: { hash: string } }[];
};

export function toCommitSummary(row: SummaryRow): CommitSummary {
  return {
    hash: row.hash, shortHash: row.hash.slice(0, SHORT_HASH_LENGTH), message: row.message,
    parents: row.parents.map((p) => p.parent.hash), createdAt: row.createdAt.toISOString(), author: row.author,
  };
}

// The cursor is the hash of the next commit to show, base64url-encoded so clients treat it as opaque.
const encodeCursor = (hash: string) => Buffer.from(hash).toString("base64url");
function decodeCursor(cursor: string): string {
  const hash = Buffer.from(cursor, "base64url").toString();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw apiError("INVALID_REQUEST", "That cursor isn't valid. Start again without it.");
  return hash;
}

/**
 * Viewer and up. Newest first, following first parents from the branch head (the branch's own line,
 * not the commits merged into it). Fetches one extra commit to know whether another page exists.
 */
export async function history(userId: string, projectId: string, branchName: string, query: z.output<typeof historyQuerySchema>, db: Db = getDb()): Promise<HistoryResponse> {
  await requireProjectRole(userId, projectId, "viewer", db);
  const branch = await db.branch.findUnique({ where: { projectId_name: { projectId, name: branchName } }, select: { headCommitId: true } });
  if (!branch) throw notFound("Branch");

  let startId = branch.headCommitId;
  if (query.cursor) {
    const start = await db.commit.findUnique({ where: { projectId_hash: { projectId, hash: decodeCursor(query.cursor) } }, select: { id: true } });
    if (!start) throw apiError("INVALID_REQUEST", "That cursor isn't valid. Start again without it.");
    startId = start.id;
  }
  if (!startId) return { commits: [], nextCursor: null };

  const line = await db.$queryRaw<{ id: string; depth: number }[]>`
    WITH RECURSIVE line(id, depth) AS (
      SELECT ${startId}::uuid, 0
      UNION ALL
      SELECT cp.parent_id, l.depth + 1 FROM commit_parents cp JOIN line l ON cp.commit_id = l.id
      WHERE cp.position = 0 AND l.depth < ${query.limit}
    )
    SELECT id, depth FROM line ORDER BY depth`;
  const page = line.slice(0, query.limit).map((r) => r.id);
  const rows = await db.commit.findMany({ where: { id: { in: page } }, select: summarySelect });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const next = line[query.limit] ? await db.commit.findUnique({ where: { id: line[query.limit].id }, select: { hash: true } }) : null;
  return { commits: page.map((id) => toCommitSummary(byId.get(id)!)), nextCursor: next ? encodeCursor(next.hash) : null };
}

// ─── Commit detail and blobs (section 8) ────────────────────────────────────

/** Viewer and up. A commit by full hash or unique 7+ character prefix, with its full file list. */
export async function commitDetail(userId: string, projectId: string, hashRef: string, db: Db = getDb()): Promise<CommitDetailResponse> {
  await requireProjectRole(userId, projectId, "viewer", db);
  const { id } = await resolveCommit(db, projectId, hashRef);
  const row = await db.commit.findUniqueOrThrow({
    where: { id },
    select: {
      ...summarySelect, aiSummary: true,
      files: { select: { path: true, role: true, blob: { select: { format: true, sha256: true, sizeBytes: true } } }, orderBy: { path: "asc" } },
    },
  });
  return { commit: {
    ...toCommitSummary(row), aiSummary: row.aiSummary,
    files: row.files.map((f) => ({
      path: f.path, format: f.blob.format, role: f.role.toLowerCase() as CommitFile["role"], sha256: f.blob.sha256, size: f.blob.sizeBytes,
    })),
  } };
}

/** Viewer and up. The blob must belong to this project; bytes come from the private bucket. */
export async function getBlob(userId: string, projectId: string, sha256: string, db: Db = getDb(),
  download: (path: string) => Promise<Uint8Array> = downloadBlob) {
  await requireProjectRole(userId, projectId, "viewer", db);
  const blob = await db.blob.findUnique({
    where: { projectId_sha256: { projectId, sha256 } }, select: { sha256: true, sizeBytes: true, contentType: true, storagePath: true },
  });
  if (!blob) throw notFound("File");
  return { sha256: blob.sha256, size: blob.sizeBytes, contentType: blob.contentType, bytes: await download(blob.storagePath) };
}
