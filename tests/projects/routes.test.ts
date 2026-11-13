import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createCookieBridge } from "@/lib/auth/cookies";

// HTTP layer only: auth, origin checks, id and body validation, status codes. The service is mocked;
// tests/projects/service.test.ts covers it against Postgres.
const mocks = vi.hoisted(() => ({ createContext: vi.fn(), getUser: vi.fn(), service: {
  listProjects: vi.fn(), createProject: vi.fn(), getProject: vi.fn(), deleteProject: vi.fn(), findProjectBySlug: vi.fn(), addMember: vi.fn(),
} }));
vi.mock("@/lib/supabase/server", () => ({ createAuthContext: mocks.createContext, createEphemeralClient: vi.fn(), createReadOnlyClient: vi.fn() }));
vi.mock("@/lib/projects/service", () => mocks.service);
import { handleAddMember, handleCreateProject, handleDeleteProject, handleGetProject, handleListProjects, handleLookupProject } from "@/lib/projects/routes";

const ORIGIN = "http://localhost:3000";
const PROJECT = "7b0c2a9e-3f1d-4c55-9a8e-2d6f0b1c4e7a";
const params = <T,>(value: T) => ({ params: Promise.resolve(value) });
const request = (path: string, method = "GET", body?: unknown, origin = ORIGIN) => new NextRequest(`${ORIGIN}${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  headers: { origin, "content-type": "application/json" },
});

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "a@example.com", email_confirmed_at: "2026-01-01" } }, error: null });
  mocks.createContext.mockImplementation(() => ({
    client: { auth: { getUser: mocks.getUser } }, bridge: createCookieBridge([], false), execute: (run: () => Promise<unknown>) => run(),
  }));
});

describe("project routes", () => {
  it("requires a session", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await handleListProjects(request("/api/projects"));
    expect(response.status).toBe(401);
    expect(mocks.service.listProjects).not.toHaveBeenCalled();
  });

  it("lists with the caller's id and the archived flag", async () => {
    mocks.service.listProjects.mockResolvedValue([]);
    const response = await handleListProjects(request("/api/projects?archived=true"));
    expect(await response.json()).toEqual({ data: { projects: [] } });
    expect(mocks.service.listProjects).toHaveBeenCalledWith("user-1", { includeArchived: true });
  });

  it("creates with 201, validates the body, and rejects other origins", async () => {
    mocks.service.createProject.mockResolvedValue({ id: PROJECT });
    expect((await handleCreateProject(request("/api/projects", "POST", { name: "Quartet" }))).status).toBe(201);
    expect(mocks.service.createProject).toHaveBeenCalledWith("user-1", { name: "Quartet" });

    const invalid = await handleCreateProject(request("/api/projects", "POST", { name: "", ownerId: "someone-else" }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.fields).toHaveProperty("name");

    expect((await handleCreateProject(request("/api/projects", "POST", { name: "X" }, "https://evil.example"))).status).toBe(403);
    expect(mocks.service.createProject).toHaveBeenCalledTimes(1);
  });

  it("treats malformed ids as not found without querying", async () => {
    const response = await handleGetProject(request("/api/projects/nope"), params({ projectId: "nope" }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("PROJECT_NOT_FOUND");
    expect(mocks.service.getProject).not.toHaveBeenCalled();
  });

  it("deletes with 204", async () => {
    mocks.service.deleteProject.mockResolvedValue(undefined);
    const response = await handleDeleteProject(request(`/api/projects/${PROJECT}`, "DELETE"), params({ projectId: PROJECT }));
    expect(response.status).toBe(204);
    expect(mocks.service.deleteProject).toHaveBeenCalledWith("user-1", PROJECT);
  });

  it("looks up by owner and slug, normalizing case", async () => {
    mocks.service.findProjectBySlug.mockResolvedValue({ id: PROJECT });
    await handleLookupProject(request("/api/projects/lookup?owner=Olivia&slug=Quartet"));
    expect(mocks.service.findProjectBySlug).toHaveBeenCalledWith("user-1", "olivia", "quartet");
    expect((await handleLookupProject(request("/api/projects/lookup?owner=olivia"))).status).toBe(404);
  });

  it("adds members by normalized username", async () => {
    mocks.service.addMember.mockResolvedValue({ role: "EDITOR" });
    const response = await handleAddMember(request(`/api/projects/${PROJECT}/members`, "POST", { username: " Edith ", role: "EDITOR" }), params({ projectId: PROJECT }));
    expect(response.status).toBe(201);
    expect(mocks.service.addMember).toHaveBeenCalledWith("user-1", PROJECT, { username: "edith", role: "EDITOR" });
  });
});
