import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { withAuthenticatedRoute } from "@/lib/auth/guards";
import { authJson, noStore, readJson } from "@/lib/auth/http";
import { validate } from "@/lib/auth/validation";
import { projectNotFound } from "./access";
import * as projects from "./service";
import {
  addMemberSchema, createProjectSchema, slugSchema, updateMemberSchema, updateProjectSchema, uuidSchema,
} from "./validation";
import { usernameSchema } from "@/lib/auth/validation";
import { notFound } from "@/lib/api/errors";

type Params<T> = { params: Promise<T> };
type ProjectParams = Params<{ projectId: string }>;
type MemberParams = Params<{ projectId: string; userId: string }>;

/** Malformed ids are a 404, the same as ids that don't exist. */
function projectId(value: string): string {
  if (!uuidSchema.safeParse(value).success) throw projectNotFound();
  return value;
}
function memberId(value: string): string {
  if (!uuidSchema.safeParse(value).success) throw notFound("MEMBER_NOT_FOUND", "That user isn't a member of this project.");
  return value;
}
const noContent = () => noStore(new NextResponse(null, { status: 204 }));

// /api/projects

export function handleListProjects(request: NextRequest) {
  return withAuthenticatedRoute(request, async (user) => {
    const includeArchived = request.nextUrl.searchParams.get("archived") === "true";
    return authJson({ projects: await projects.listProjects(user.id, { includeArchived }) });
  });
}

export function handleCreateProject(request: NextRequest) {
  return withAuthenticatedRoute(request, async (user) => {
    const input = validate(createProjectSchema, await readJson(request));
    return authJson({ project: await projects.createProject(user.id, input) }, 201);
  });
}

// /api/projects/lookup?owner=<username>&slug=<slug>

export function handleLookupProject(request: NextRequest) {
  return withAuthenticatedRoute(request, async (user) => {
    const params = request.nextUrl.searchParams;
    const owner = usernameSchema.safeParse(params.get("owner") ?? "");
    const slug = slugSchema.safeParse(params.get("slug") ?? "");
    if (!owner.success || !slug.success) throw projectNotFound();
    return authJson({ project: await projects.findProjectBySlug(user.id, owner.data, slug.data) });
  });
}

// /api/projects/[projectId]

export function handleGetProject(request: NextRequest, { params }: ProjectParams) {
  return withAuthenticatedRoute(request, async (user) => {
    const id = projectId((await params).projectId);
    return authJson({ project: await projects.getProject(user.id, id) });
  });
}

export function handleUpdateProject(request: NextRequest, { params }: ProjectParams) {
  return withAuthenticatedRoute(request, async (user) => {
    const id = projectId((await params).projectId);
    const input = validate(updateProjectSchema, await readJson(request));
    return authJson({ project: await projects.updateProject(user.id, id, input) });
  });
}

export function handleDeleteProject(request: NextRequest, { params }: ProjectParams) {
  return withAuthenticatedRoute(request, async (user) => {
    await projects.deleteProject(user.id, projectId((await params).projectId));
    return noContent();
  });
}

// /api/projects/[projectId]/members

export function handleListMembers(request: NextRequest, { params }: ProjectParams) {
  return withAuthenticatedRoute(request, async (user) => {
    return authJson(await projects.listMembers(user.id, projectId((await params).projectId)));
  });
}

export function handleAddMember(request: NextRequest, { params }: ProjectParams) {
  return withAuthenticatedRoute(request, async (user) => {
    const id = projectId((await params).projectId);
    const input = validate(addMemberSchema, await readJson(request));
    return authJson({ member: await projects.addMember(user.id, id, input) }, 201);
  });
}

// /api/projects/[projectId]/members/[userId]

export function handleUpdateMember(request: NextRequest, { params }: MemberParams) {
  return withAuthenticatedRoute(request, async (user) => {
    const raw = await params;
    const id = projectId(raw.projectId);
    const member = memberId(raw.userId);
    const input = validate(updateMemberSchema, await readJson(request));
    return authJson({ member: await projects.updateMember(user.id, id, member, input) });
  });
}

export function handleRemoveMember(request: NextRequest, { params }: MemberParams) {
  return withAuthenticatedRoute(request, async (user) => {
    const raw = await params;
    await projects.removeMember(user.id, projectId(raw.projectId), memberId(raw.userId));
    return noContent();
  });
}
