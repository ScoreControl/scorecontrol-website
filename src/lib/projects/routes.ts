import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { readJson } from "@/lib/auth/http";
import { enforceSubjectLimit } from "@/lib/auth/rate-limit";
import { validate } from "@/lib/auth/validation";
import { apiJson, withApiRoute } from "@/lib/api/route";
import { apiError, notFound } from "@/lib/api/errors";
import { branchNameSchema, createBranchRequestSchema, blobQuerySchema, commitMetadataSchema, suggestionMetadataSchema, createProjectRequestSchema, idempotencyKeySchema, MAX_FILE_BYTES, MAX_FILES_PER_COMMIT, fullHashSchema, hashRefSchema, historyQuerySchema, syncQuerySchema, updateBranchRequestSchema } from "@/lib/api/contract";
import * as service from "./service";
import { createCommit, type UploadedFile } from "./commit";
import { suggestCommitMessage } from "./suggest";

// Route handlers for section 5 of docs/api-contract.md. Role checks live in the service.

type Ctx<T> = { params: Promise<T> };

/** withApiRoute already ran the origin check for cookie callers; bearer callers skip it by design. */
const body = (request: NextRequest) => readJson(request, { checkOrigin: false });

/** Branch names may contain "/", so the route captures them as a catch-all. */
function branchName(segments: string[]): string {
  const name = segments.map(decodeURIComponent).join("/");
  if (!branchNameSchema.safeParse(name).success) throw notFound("Branch");
  return name;
}

export const handleListProjects = (request: NextRequest) =>
  withApiRoute(request, async (caller) => apiJson(await service.listProjects(caller.id)));

export const handleCreateProject = (request: NextRequest) =>
  withApiRoute(request, async (caller) => {
    const input = validate(createProjectRequestSchema, await body(request));
    return apiJson(await service.createProject(caller.id, input), 201);
  });

export const handleGetProject = (request: NextRequest, { params }: Ctx<{ id: string }>) =>
  withApiRoute(request, async (caller) => apiJson(await service.getProject(caller.id, (await params).id)));

export const handleListBranches = (request: NextRequest, { params }: Ctx<{ id: string }>) =>
  withApiRoute(request, async (caller) => {
    const includeArchived = ["1", "true"].includes(request.nextUrl.searchParams.get("includeArchived") ?? "");
    return apiJson(await service.listBranches(caller.id, (await params).id, includeArchived));
  });

export const handleCreateBranch = (request: NextRequest, { params }: Ctx<{ id: string }>) =>
  withApiRoute(request, async (caller) => {
    const { id } = await params;
    const input = validate(createBranchRequestSchema, await body(request));
    return apiJson(await service.createBranch(caller.id, id, input), 201);
  });

export const handleUpdateBranch = (request: NextRequest, { params }: Ctx<{ id: string; name: string[] }>) =>
  withApiRoute(request, async (caller) => {
    const { id, name } = await params;
    const input = validate(updateBranchRequestSchema, await body(request));
    return apiJson(await service.setBranchArchived(caller.id, id, branchName(name), input.archived));
  });

export const handleSync = (request: NextRequest, { params }: Ctx<{ id: string }>) =>
  withApiRoute(request, async (caller) => {
    const query = validate(syncQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
    return apiJson(await service.sync(caller.id, (await params).id, query));
  });

/**
 * GET .../branches/:name/commits. Branch names can contain "/", so this shares the branches catch-all
 * route: a trailing "commits" segment means history (a branch named "commits" is .../commits/commits).
 */
export const handleBranchGet = (request: NextRequest, { params }: Ctx<{ id: string; name: string[] }>) =>
  withApiRoute(request, async (caller) => {
    const { id, name } = await params;
    if (name.length < 2 || name.at(-1) !== "commits") throw notFound();
    const query = validate(historyQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
    return apiJson(await service.history(caller.id, id, branchName(name.slice(0, -1)), query));
  });

export const handleCommitDetail = (request: NextRequest, { params }: Ctx<{ id: string; hash: string }>) =>
  withApiRoute(request, async (caller) => {
    const { id, hash } = await params;
    const ref = hashRefSchema.safeParse(hash);
    if (!ref.success) throw notFound("Commit");
    return apiJson(await service.commitDetail(caller.id, id, ref.data));
  });

/** Raw bytes by default; `?encoding=base64` returns JSON for plugin runtimes that handle binary poorly. */
export const handleBlob = (request: NextRequest, { params }: Ctx<{ id: string; sha256: string }>) =>
  withApiRoute(request, async (caller) => {
    const { id, sha256 } = await params;
    const sha = fullHashSchema.safeParse(sha256.toLowerCase());
    if (!sha.success) throw notFound("File");
    const { encoding } = validate(blobQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
    const blob = await service.getBlob(caller.id, id, sha.data);
    if (encoding === "base64") {
      return apiJson({ sha256: blob.sha256, size: blob.size, contentType: blob.contentType, base64: Buffer.from(blob.bytes).toString("base64") });
    }
    return new NextResponse(Buffer.from(blob.bytes), {
      headers: { "Content-Type": blob.contentType, "Content-Length": String(blob.bytes.byteLength), "X-Content-Type-Options": "nosniff" },
    });
  });

/** Upper bound on a whole commit request: 100 files of 25 MB each would be too much for one upload. */
const MAX_COMMIT_BYTES = 4 * MAX_FILE_BYTES;

/**
 * Reads a multipart commit-style body: a JSON `metadata` part validated by `schema`, plus one part
 * per `files` entry, named by its `field`. Shared by the commit and suggestion routes.
 */
async function readFilesForm<S extends typeof commitMetadataSchema | typeof suggestionMetadataSchema>(request: NextRequest, schema: S) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    throw apiError("UNSUPPORTED_MEDIA_TYPE", "Send the request as multipart/form-data.");
  }
  if (Number(request.headers.get("content-length")) > MAX_COMMIT_BYTES) {
    throw apiError("REQUEST_TOO_LARGE", "The request is too large to upload at once.");
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw apiError("INVALID_REQUEST", "Send a valid multipart/form-data body.");
  }
  const raw = form.get("metadata");
  let json: unknown;
  try {
    json = JSON.parse(typeof raw === "string" ? raw : raw ? await raw.text() : "");
  } catch {
    throw apiError("INVALID_REQUEST", "The metadata part must be JSON.");
  }
  const count = (json as { files?: unknown[] } | null)?.files?.length ?? 0;
  if (count > MAX_FILES_PER_COMMIT) throw apiError("TOO_MANY_FILES", `A commit can hold at most ${MAX_FILES_PER_COMMIT} files.`);
  const metadata = validate(schema, json) as import("zod").output<S>;

  const parts = new Map<string, UploadedFile>();
  for (const entry of metadata.files) {
    const part = form.get(entry.field);
    if (part instanceof Blob) parts.set(entry.field, { bytes: new Uint8Array(await part.arrayBuffer()), contentType: part.type });
  }
  return { metadata, parts };
}

/**
 * POST /api/projects/:id/commits: multipart/form-data with a JSON `metadata` part and one part per
 * file, named by its entry's `field`. The optional Idempotency-Key header makes retries safe.
 */
export const handleCreateCommit = (request: NextRequest, { params }: Ctx<{ id: string }>) =>
  withApiRoute(request, async (caller) => {
    const { id } = await params;
    const key = request.headers.get("idempotency-key");
    if (key !== null && !idempotencyKeySchema.safeParse(key).success) {
      throw apiError("INVALID_REQUEST", "Idempotency-Key must be 8 to 128 letters, digits, '_' or '-'.");
    }
    await enforceSubjectLimit("commit", caller.id);
    const { metadata, parts } = await readFilesForm(request, commitMetadataSchema);
    return apiJson(await createCommit(caller.id, id, metadata, parts, key), 201);
  });

/** POST /api/projects/:id/commit-message-suggestions: the same multipart body as a commit, minus the message. */
export const handleSuggestCommitMessage = (request: NextRequest, { params }: Ctx<{ id: string }>) =>
  withApiRoute(request, async (caller) => {
    const { id } = await params;
    await enforceSubjectLimit("suggest", caller.id);
    const { metadata, parts } = await readFilesForm(request, suggestionMetadataSchema);
    return apiJson(await suggestCommitMessage(caller.id, id, metadata, parts));
  });
