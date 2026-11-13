import "server-only";
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { FileFormat, Prisma, PrismaClient } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { apiError, notFound, staleParent } from "@/lib/api/errors";
import { requireProjectRole } from "@/lib/api/roles";
import { MAX_FILE_BYTES, type CommitResponse, type commitMetadataSchema } from "@/lib/api/contract";
import { blobPath, uploadBlob } from "@/lib/storage";
import { branchSelect, commitsAhead, resolveCommit, summarySelect, toBranch, toCommitSummary } from "./service";

// Section 7 of docs/api-contract.md: POST /api/projects/:id/commits.

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
export type CommitMetadata = z.output<typeof commitMetadataSchema>;
export type UploadedFile = { bytes: Uint8Array; contentType: string };

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "P2002";

/** Used when the form part has no useful type of its own. */
const CONTENT_TYPES: Record<FileFormat, string> = {
  MUSICXML: "application/vnd.recordare.musicxml+xml",
  MXL: "application/vnd.recordare.musicxml",
  MSCZ: "application/x-musescore",
  MSCX: "application/x-musescore+xml",
  OTHER: "application/octet-stream",
};

/** Contract section 2: SHA-256 of canonical JSON, keys in this order, parents sorted, tree sorted by path. */
export function commitHash(input: { parents: string[]; tree: [string, string][]; message: string; authorId: string; createdAt: Date }): string {
  const tree = [...input.tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(JSON.stringify({
    parents: [...input.parents].sort(), tree, message: input.message, authorId: input.authorId, createdAt: input.createdAt.toISOString(),
  }));
}

/** Pairs each metadata entry with its form part, enforcing the per-file limit. */
function snapshot(metadata: CommitMetadata, parts: Map<string, UploadedFile>) {
  return metadata.files.map((entry) => {
    const part = parts.get(entry.field);
    if (!part) throw apiError("INVALID_REQUEST", `Missing the file part "${entry.field}" for ${entry.path}.`);
    if (part.bytes.byteLength === 0) throw apiError("VALIDATION_FAILED", `${entry.path} is empty.`);
    if (part.bytes.byteLength > MAX_FILE_BYTES) throw apiError("FILE_TOO_LARGE", `${entry.path} is larger than 25 MB.`);
    const generic = !part.contentType || part.contentType === "application/octet-stream";
    return {
      ...entry, bytes: part.bytes, sha256: sha256(part.bytes),
      contentType: generic ? CONTENT_TYPES[entry.format] : part.contentType,
    };
  });
}

/**
 * Editor and up. Creates a commit from a full snapshot of files, atomically:
 * - without `newBranch`, `parentHash` must be the branch head (409 STALE_PARENT otherwise);
 * - with `newBranch`, the branch is created at `parentHash` and the commit goes onto it.
 * An Idempotency-Key replays the stored 201 for the same request and rejects a different one.
 */
export async function createCommit(userId: string, projectId: string, metadata: CommitMetadata, parts: Map<string, UploadedFile>,
  idempotencyKey: string | null, db: Db = getDb(), upload = uploadBlob): Promise<CommitResponse> {
  await requireProjectRole(userId, projectId, "editor", db);
  const files = snapshot(metadata, parts);

  // The request's identity for idempotency: metadata plus the bytes' hashes, not the field names.
  const requestHash = sha256(JSON.stringify({
    projectId, ...metadata, files: files.map(({ path, format, role, sha256: hash }) => ({ path, format, role, hash })),
  }));
  if (idempotencyKey) {
    const stored = await db.idempotencyKey.findUnique({ where: { userId_key: { userId, key: idempotencyKey } } });
    if (stored && stored.createdAt.getTime() > Date.now() - IDEMPOTENCY_TTL_MS) {
      if (stored.requestHash !== requestHash) throw apiError("IDEMPOTENCY_CONFLICT", "That Idempotency-Key was already used for a different commit.");
      return stored.responseBody as CommitResponse;
    }
    if (stored) await db.idempotencyKey.delete({ where: { userId_key: { userId, key: idempotencyKey } } });
  }

  // Upload first: objects are content-addressed, so a failed transaction only leaves unused bytes.
  const known = new Set((await db.blob.findMany({
    where: { projectId, sha256: { in: files.map((f) => f.sha256) } }, select: { sha256: true },
  })).map((b) => b.sha256));
  const uploaded = new Set<string>();
  for (const file of files) {
    if (known.has(file.sha256) || uploaded.has(file.sha256)) continue;
    await upload(blobPath(projectId, file.sha256), file.bytes, file.contentType);
    uploaded.add(file.sha256);
  }

  try {
    return await db.$transaction(async (tx) => {
      const { branch, parent, created } = metadata.newBranch
        ? await forkBranch(tx, userId, projectId, metadata)
        : await lockBranch(tx, projectId, metadata);

      if (parent) {
        const previous = await tx.commitFile.findMany({ where: { commitId: parent.id }, select: { path: true, blob: { select: { sha256: true } } } });
        const same = previous.length === files.length &&
          previous.every((p) => files.some((f) => f.path === p.path && f.sha256 === p.blob.sha256));
        if (same) throw apiError("NO_CHANGES", "Nothing changed since the parent commit.");
      }

      await tx.blob.createMany({
        data: files.map((f) => ({
          projectId, sha256: f.sha256, sizeBytes: f.bytes.byteLength, format: f.format, contentType: f.contentType, storagePath: blobPath(projectId, f.sha256),
        })),
        skipDuplicates: true,
      });
      const blobIds = new Map((await tx.blob.findMany({
        where: { projectId, sha256: { in: files.map((f) => f.sha256) } }, select: { id: true, sha256: true },
      })).map((b) => [b.sha256, b.id]));

      const createdAt = new Date();
      const hash = commitHash({
        parents: parent ? [parent.hash] : [], tree: files.map((f) => [f.path, f.sha256]), message: metadata.message, authorId: userId, createdAt,
      });
      const commit = await tx.commit.create({
        data: {
          projectId, authorId: userId, message: metadata.message, aiSummary: metadata.aiSummary ?? null, hash, createdAt,
          parents: parent ? { create: [{ parentId: parent.id, position: 0 }] } : undefined,
          files: { create: files.map((f) => ({ path: f.path, blobId: blobIds.get(f.sha256)!, role: f.role.toUpperCase() as "PRIMARY" })) },
        },
        select: summarySelect,
      });
      const head = await tx.branch.update({ where: { id: branch.id }, data: { headCommitId: commit.id }, select: branchSelect });
      await tx.project.update({ where: { id: projectId }, data: { updatedAt: createdAt } });

      const response: CommitResponse = { commit: toCommitSummary(commit), branch: { ...toBranch(head), created } };
      if (idempotencyKey) {
        await tx.idempotencyKey.create({
          data: { userId, key: idempotencyKey, requestHash, responseStatus: 201, responseBody: response as unknown as Prisma.InputJsonValue },
        });
      }
      return response;
    });
  } catch (error) {
    // Two retries with the same key raced; the loser replays the winner's stored response.
    if (idempotencyKey && isUniqueViolation(error) &&
      await db.idempotencyKey.findUnique({ where: { userId_key: { userId, key: idempotencyKey } }, select: { key: true } })) {
      return createCommit(userId, projectId, metadata, parts, idempotencyKey, db, upload);
    }
    throw error;
  }
}

/** Locks the branch row so concurrent commits serialize, then checks parentHash against the head. */
async function lockBranch(tx: Tx, projectId: string, metadata: CommitMetadata) {
  const [row] = await tx.$queryRaw<{ id: string; head_commit_id: string | null; archived_at: Date | null }[]>`
    SELECT id, head_commit_id, archived_at FROM branches WHERE project_id = ${projectId}::uuid AND name = ${metadata.branch} FOR UPDATE`;
  if (!row) throw notFound("Branch");
  if (row.archived_at) throw apiError("BRANCH_ARCHIVED", `Branch ${metadata.branch} is archived. Unarchive it or commit to a new branch.`);

  const head = row.head_commit_id
    ? await tx.commit.findUniqueOrThrow({ where: { id: row.head_commit_id }, select: { id: true, hash: true, message: true } })
    : null;
  let parent: { id: string; hash: string } | null = null;
  if (metadata.parentHash) {
    try {
      parent = await resolveCommit(tx, projectId, metadata.parentHash);
    } catch (error) {
      if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
    }
  }
  const matches = head ? parent?.id === head.id : metadata.parentHash === null;
  if (!matches) {
    throw staleParent({
      branch: metadata.branch, headHash: head?.hash ?? null, headMessage: head?.message ?? null, yourParent: parent?.hash ?? metadata.parentHash,
      commitsAhead: head && parent ? await commitsAhead(tx, head.id, parent.id) : null,
    });
  }
  return { branch: { id: row.id }, parent: head, created: false };
}

/** Creates `newBranch` at parentHash inside the transaction; a taken name is BRANCH_EXISTS. */
async function forkBranch(tx: Tx, userId: string, projectId: string, metadata: CommitMetadata) {
  if (!metadata.parentHash) throw apiError("VALIDATION_FAILED", "A new branch needs a parentHash to start from.");
  const parent = await resolveCommit(tx, projectId, metadata.parentHash);
  const name = metadata.newBranch!.name;
  if (await tx.branch.findUnique({ where: { projectId_name: { projectId, name } }, select: { id: true } })) {
    throw apiError("BRANCH_EXISTS", `A branch named ${name} already exists.`);
  }
  const branch = await tx.branch.create({ data: { projectId, name, headCommitId: parent.id, createdById: userId }, select: { id: true } });
  return { branch, parent, created: true };
}
