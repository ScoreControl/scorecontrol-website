import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { readJson } from "@/lib/auth/http";
import { validate } from "@/lib/auth/validation";
import { apiJson, withApiRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/errors";
import { branchNameSchema, createBranchRequestSchema, blobQuerySchema, createProjectRequestSchema, fullHashSchema, hashRefSchema, historyQuerySchema, syncQuerySchema, updateBranchRequestSchema } from "@/lib/api/contract";
import * as service from "./service";

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
