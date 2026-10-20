import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, createCookieBridge } from "@/lib/auth/cookies";
const mocks = vi.hoisted(() => ({ create: vi.fn(), readOnly: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAuthContext: mocks.create, createReadOnlyClient: mocks.readOnly }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
import { withAuthenticatedRoute } from "@/lib/auth/guards";
import { requirePageUser } from "@/lib/auth/user";
const user = { id: "verified-id", email: "person@example.com", email_confirmed_at: "2026-01-01" };
const getUser = vi.fn();
let bridge: ReturnType<typeof createCookieBridge>;
const request = () => new NextRequest("http://localhost:3000/api/private", { headers: { cookie: `${AUTH_COOKIE}=old` } });
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  bridge = createCookieBridge([{ name: AUTH_COOKIE, value: "old" }], false);
  getUser.mockReset();
  const context = { client: { auth: { getUser } }, bridge, execute: (operation: () => Promise<unknown>) => operation() };
  mocks.create.mockReturnValue(context);
  mocks.readOnly.mockResolvedValue(context.client);
  mocks.redirect.mockImplementation(() => { throw new Error("page-redirect"); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("never runs the protected operation for an unauthenticated request", async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError" } });
  const handler = vi.fn();
  const response = await withAuthenticatedRoute(request(), handler);
  expect(response.status).toBe(401);
  expect(response.cookies.get(AUTH_COOKIE)?.maxAge).toBe(0);
  expect(handler).not.toHaveBeenCalled();
});
it("fails closed during outages without clearing the browser session", async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: { status: 503 } });
  const handler = vi.fn();
  const response = await withAuthenticatedRoute(request(), handler);
  expect(response.status).toBe(503);
  expect(handler).not.toHaveBeenCalled();
  expect(response.cookies.getAll()).toEqual([]);
});
it("passes only the verified identity and keeps refresh cookies on subsequent application failure", async () => {
  getUser.mockImplementation(async () => {
    bridge.setAll([{ name: AUTH_COOKIE, value: "rotated", options: {} }]);
    return { data: { user }, error: null };
  });
  const response = await withAuthenticatedRoute(request(), async (identity) => {
    expect(identity.id).toBe("verified-id");
    throw new Error("private application error");
  });
  expect(response.status).toBe(500);
  expect(response.cookies.get(AUTH_COOKIE)?.value).toBe("rotated");
  expect(JSON.stringify(await response.json())).not.toContain("private application error");
});
it("returns a successful protected response with refreshed credentials", async () => {
  getUser.mockResolvedValue({ data: { user }, error: null });
  const response = await withAuthenticatedRoute(request(), async (identity) => NextResponse.json({ owner: identity.id }));
  expect(await response.json()).toEqual({ owner: "verified-id" });
});
it("uses the page redirect adapter for signed-out visitors", async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError" } });
  await expect(requirePageUser()).rejects.toThrow("page-redirect");
  expect(mocks.redirect).toHaveBeenCalledWith("/login");
});
it("does not turn provider outages into a misleading login redirect", async () => {
  mocks.redirect.mockClear();
  getUser.mockResolvedValue({ data: { user: null }, error: { status: 503 } });
  await expect(requirePageUser()).rejects.toMatchObject({ status: 503 });
  expect(mocks.redirect).not.toHaveBeenCalled();
});
it("rejects cross-origin state-changing requests before verifying identity", async () => {
  const handler = vi.fn();
  const crossSite = new NextRequest("http://localhost:3000/api/private", { method: "DELETE",
    headers: { cookie: `${AUTH_COOKIE}=old`, origin: "https://evil.example" } });
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  const response = await withAuthenticatedRoute(crossSite, handler);
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
  expect(getUser).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
it("allows same-origin state-changing requests", async () => {
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  getUser.mockResolvedValue({ data: { user }, error: null });
  const sameOrigin = new NextRequest("http://localhost:3000/api/private", { method: "POST",
    headers: { cookie: `${AUTH_COOKIE}=old`, origin: "http://localhost:3000" } });
  expect((await withAuthenticatedRoute(sameOrigin, async () => NextResponse.json({ ok: true }))).status).toBe(200);
});
it("does not depend on the username registry for protected operations", async () => {
  vi.stubEnv("SUPABASE_SECRET_KEY", ""); // Any username lookup would fail with AUTH_NOT_CONFIGURED.
  getUser.mockResolvedValue({ data: { user }, error: null });
  const response = await withAuthenticatedRoute(request(), async (identity) => NextResponse.json(identity));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "verified-id", email: "person@example.com", emailVerified: true });
});
it("passes a validated return path to the login page", async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError" } });
  await expect(requirePageUser("/scores/42?tab=history")).rejects.toThrow("page-redirect");
  expect(mocks.redirect).toHaveBeenCalledWith("/login?next=%2Fscores%2F42%3Ftab%3Dhistory");
  await expect(requirePageUser("//evil.example")).rejects.toThrow("page-redirect");
  expect(mocks.redirect).toHaveBeenLastCalledWith("/login");
});
