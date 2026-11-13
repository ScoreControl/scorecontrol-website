import "server-only";
import type { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { apiError } from "@/lib/api/errors";
import { requireProjectRole } from "@/lib/api/roles";
import { MAX_FILE_BYTES, type SuggestionResponse, type suggestionMetadataSchema } from "@/lib/api/contract";
import { downloadBlob } from "@/lib/storage";
import { diffSuggestion, initialSuggestion, RULES_MODEL, type FileVersion } from "@/lib/suggestions/rules";
import { resolveCommit } from "./service";
import type { UploadedFile } from "./commit";
import { createHash } from "node:crypto";

// Section 9 of docs/api-contract.md. Free rule-based suggestions for now; an LLM can replace
// suggestCommitMessage later without changing the route.

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Editor and up. Advisory: the plugin falls back to an empty box on any error, so this never
 * blocks committing. A parentHash the project doesn't have is treated as a first commit.
 */
export async function suggestCommitMessage(userId: string, projectId: string, metadata: z.output<typeof suggestionMetadataSchema>,
  parts: Map<string, UploadedFile>, db: PrismaClient = getDb(), download = downloadBlob): Promise<SuggestionResponse> {
  await requireProjectRole(userId, projectId, "editor", db);
  const files: (FileVersion & { role: string })[] = metadata.files.map((entry) => {
    const part = parts.get(entry.field);
    if (!part) throw apiError("INVALID_REQUEST", `Missing the file part "${entry.field}" for ${entry.path}.`);
    if (part.bytes.byteLength > MAX_FILE_BYTES) throw apiError("FILE_TOO_LARGE", `${entry.path} is larger than 25 MB.`);
    return { path: entry.path, sha256: sha256(part.bytes), bytes: entry.role === "primary" ? part.bytes : undefined, role: entry.role };
  });
  const primary = files.find((f) => f.role === "primary")!;
  const others = files.filter((f) => f !== primary);

  let parentId: string | null = null;
  if (metadata.parentHash) {
    try {
      parentId = (await resolveCommit(db, projectId, metadata.parentHash)).id;
    } catch (error) {
      if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
    }
  }
  if (!parentId) return { ...initialSuggestion(primary, others), model: RULES_MODEL };

  const previous = await db.commitFile.findMany({
    where: { commitId: parentId }, select: { path: true, role: true, blob: { select: { sha256: true, storagePath: true } } },
  });
  const oldPrimaryRow = previous.find((f) => f.role === "PRIMARY") ?? previous[0];
  const oldPrimary: FileVersion = { path: oldPrimaryRow.path, sha256: oldPrimaryRow.blob.sha256 };
  // Only download the parent's score when it differs; unreadable bytes just mean a plainer message.
  if (oldPrimary.sha256 !== primary.sha256) oldPrimary.bytes = await download(oldPrimaryRow.blob.storagePath).catch(() => undefined);

  const suggestion = diffSuggestion(
    { primary: oldPrimary, files: previous.map((f) => ({ path: f.path, sha256: f.blob.sha256 })) },
    { primary, files },
  );
  return { ...suggestion, model: RULES_MODEL };
}
