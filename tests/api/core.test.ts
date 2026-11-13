import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, createCookieBridge } from "@/lib/auth/cookies";

const mocks = vi.hoisted(() => ({ create: vi.fn(), ephemeral: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAuthContext: mocks.create, createEphemeralClient: mocks.ephemeral }));
vi.mock("@/lib/db", () => ({ getDb: () => { throw new Error("tests pass a db explicitly"); } }));

import { bearerToken, verifyAccessToken } from "@/lib/api/auth";
import { hasRole, requireProjectRole } from "@/lib/api/roles";
import { apiJson, withApiRoute } from "@/lib/api/route";
import { apiError, staleParent } from "@/lib/api/errors";
import { errorResponse } from "@/lib/auth/http";

const ORIGIN = "http://localhost:3000";
const supabaseUser = { id: "11111111-1111-4111-8111-111111111111", email: "ryan@example.com", email_confirmed_at: "2026-01-01" };
const jwt = (exp: number) => ["e30", Buffer.from(JSON.stringify({ sub: supabaseUser.id, exp })).toString("base64url"), "sig"].join(".");
const fresh = () => jwt(Math.floor(Date.now() / 1000) + 3600);
const tokenGetUser = vi.fn();
const cookieGetUser = vi.fn();

function request(method = "GET", headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}/api/projects`, { method, headers });
}

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  vi.spyOn(console, "error").mockImplementation(() => {});
  tokenGetUser.mockReset();
  cookieGetUser.mockReset();
  mocks.ephemeral.mockReturnValue({ auth: { getUser: tokenGetUser } });
  mocks.create.mockReturnValue({
    client: { auth: { getUser: cookieGetUser } },
    bridge: createCookieBridge([{ name: AUTH_COOKIE, value: "session" }], false),
    execute: (operation: () => Promise<unknown>) => operation(),
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("bearerToken", () => {
  it("returns null without an Authorization header", () => {
    expect(bearerToken(request())).toBeNull();
  });
  it("extracts a JWT", () => {
    const token = fresh();
    expect(bearerToken(request("GET", { authorization: `Bearer ${token}` }))).toBe(token);
  });
  it.each(["Bearer", "Bearer not-a-jwt", "Basic abc", `bearer ${"a.b.c"}`, `Bearer ${"a".repeat(5000)}.b.c`])(
    "rejects a malformed header %#", (header) => {
      expect(() => bearerToken(request("GET", { authorization: header }))).toThrow(expect.objectContaining({ status: 401, code: "UNAUTHENTICATED" }));
    });
});

describe("verifyAccessToken", () => {
  it("returns the provider-verified identity", async () => {
    tokenGetUser.mockResolvedValue({ data: { user: supabaseUser }, error: null });
    await expect(verifyAccessToken(fresh())).resolves.toEqual({ id: supabaseUser.id, email: supabaseUser.email, emailVerified: true });
    expect(tokenGetUser).toHaveBeenCalledWith(expect.any(String));
  });
  it("answers TOKEN_EXPIRED without calling the provider", async () => {
    await expect(verifyAccessToken(jwt(Math.floor(Date.now() / 1000) - 1))).rejects.toMatchObject({ status: 401, code: "TOKEN_EXPIRED" });
    expect(tokenGetUser).not.toHaveBeenCalled();
  });
  it("rejects tokens the provider refuses", async () => {
    tokenGetUser.mockResolvedValue({ data: { user: null }, error: { status: 403, code: "bad_jwt" } });
    await expect(verifyAccessToken(fresh())).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });
  it("fails closed with 503 during provider outages", async () => {
    tokenGetUser.mockResolvedValue({ data: { user: null }, error: { status: 500 } });
    await expect(verifyAccessToken(fresh())).rejects.toMatchObject({ status: 503 });
  });
  it("rejects an unreadable payload", async () => {
    await expect(verifyAccessToken("a.%%%.c")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("withApiRoute", () => {
  const ok = vi.fn(async (caller: { id: string; via: string }) => apiJson({ id: caller.id, via: caller.via }));

  it("authenticates the plugin by bearer token and skips the origin check", async () => {
    tokenGetUser.mockResolvedValue({ data: { user: supabaseUser }, error: null });
    const response = await withApiRoute(request("POST", { authorization: `Bearer ${fresh()}` }), ok);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: supabaseUser.id, via: "bearer" } });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.cookies.getAll()).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("authenticates the web app by cookie", async () => {
    cookieGetUser.mockResolvedValue({ data: { user: supabaseUser }, error: null });
    const response = await withApiRoute(request("GET", { cookie: `${AUTH_COOKIE}=session` }), ok);
    expect(await response.json()).toEqual({ data: { id: supabaseUser.id, via: "cookie" } });
  });
  it("still requires the app origin for state-changing cookie requests", async () => {
    const response = await withApiRoute(request("POST", { cookie: `${AUTH_COOKIE}=session`, origin: "https://evil.example" }), ok);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(cookieGetUser).not.toHaveBeenCalled();
  });
  it("returns TOKEN_EXPIRED and never runs the handler", async () => {
    const handler = vi.fn();
    const response = await withApiRoute(request("GET", { authorization: `Bearer ${jwt(1)}` }), handler);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("TOKEN_EXPIRED");
    expect(handler).not.toHaveBeenCalled();
  });
  it("does not fall back to cookies when a bearer header is malformed", async () => {
    const response = await withApiRoute(request("GET", { authorization: "Bearer junk", cookie: `${AUTH_COOKIE}=session` }), ok);
    expect(response.status).toBe(401);
    expect(cookieGetUser).not.toHaveBeenCalled();
  });
  it("formats handler errors with the contract envelope", async () => {
    tokenGetUser.mockResolvedValue({ data: { user: supabaseUser }, error: null });
    const details = { branch: "main", headHash: null, headMessage: null, yourParent: null, commitsAhead: null };
    const response = await withApiRoute(request("POST", { authorization: `Bearer ${fresh()}` }), async () => { throw staleParent(details); });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "STALE_PARENT", message: "Branch main has moved.", details } });
  });
  it("hides unexpected handler errors", async () => {
    tokenGetUser.mockResolvedValue({ data: { user: supabaseUser }, error: null });
    const response = await withApiRoute(request("GET", { authorization: `Bearer ${fresh()}` }), async () => { throw new Error("secret detail"); });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret detail");
  });
});

describe("requireProjectRole", () => {
  const projectId = "22222222-2222-4222-8222-222222222222";
  const owner = "33333333-3333-4333-8333-333333333333";
  const member = "44444444-4444-4444-8444-444444444444";
  const db = (role?: "VIEWER" | "EDITOR" | "ADMIN", exists = true) => ({
    project: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => exists && where.id === projectId
      ? { id: projectId, ownerId: owner, defaultBranchId: null, members: role ? [{ role }] : [] } : null) },
  }) as never;

  it("treats the owner as owner", async () => {
    await expect(requireProjectRole(owner, projectId, "owner", db())).resolves.toMatchObject({ role: "owner" });
  });
  it.each([["VIEWER", "viewer"], ["EDITOR", "editor"], ["ADMIN", "admin"]] as const)("maps member role %s", async (role, expected) => {
    await expect(requireProjectRole(member, projectId, "viewer", db(role))).resolves.toMatchObject({ role: expected });
  });
  it("returns 403 when a member's role is too low", async () => {
    await expect(requireProjectRole(member, projectId, "editor", db("VIEWER"))).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(requireProjectRole(member, projectId, "admin", db("EDITOR"))).rejects.toMatchObject({ status: 403 });
  });
  it("returns the same 404 for non-members, missing projects, and malformed ids", async () => {
    for (const attempt of [requireProjectRole(member, projectId, "viewer", db()),
      requireProjectRole(member, projectId, "viewer", db("ADMIN", false)),
      requireProjectRole(member, "not-a-uuid", "viewer", db("ADMIN"))]) {
      await expect(attempt).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    }
  });
  it("orders roles", () => {
    expect(hasRole("admin", "editor")).toBe(true);
    expect(hasRole("editor", "admin")).toBe(false);
    expect(hasRole("owner", "admin")).toBe(true);
  });
});

describe("apiError", () => {
  it("takes the status from the contract", async () => {
    const response = errorResponse(apiError("NO_CHANGES", "Nothing to commit."));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("NO_CHANGES");
  });
});

it("apiJson wraps data", async () => {
  const response: NextResponse = apiJson({ ok: true }, 201);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ data: { ok: true } });
});
