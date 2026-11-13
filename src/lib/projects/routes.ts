import "server-only";
import type { NextRequest } from "next/server";
import { readJson } from "@/lib/auth/http";
import { validate } from "@/lib/auth/validation";
import { apiJson, withApiRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/errors";
import { branchNameSchema, createBranchRequestSchema, createProjectRequestSchema, syncQuerySchema, updateBranchRequestSchema } from "@/lib/api/contract";
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
