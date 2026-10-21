import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AUTH_COOKIE, createCookieBridge } from "@/lib/auth/cookies";
const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAuthContext: mock.create }));
import { updateSession } from "@/lib/supabase/proxy";

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe("page session proxy", () => {
  it("does not require auth configuration for a public visitor without cookies", async () => {
    mock.create.mockClear();
    expect((await updateSession(new NextRequest("http://localhost:3000/"))).status).toBe(200);
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("forwards refreshed request cookies AND browser cookies", async () => {
    const request = new NextRequest("http://localhost:3000/", { headers: { cookie: `${AUTH_COOKIE}=old` } });
    const bridge = createCookieBridge(request.cookies.getAll(), false);
    mock.create.mockReturnValue({ bridge, execute: (operation: () => Promise<unknown>) => operation(), client: { auth: { getClaims: async () => {
      bridge.setAll([{ name: AUTH_COOKIE, value: "refreshed", options: {} }]);
      return { data: { claims: { sub: "user-id" } }, error: null };
    } } } });
    const response = await updateSession(request);
    expect(request.cookies.get(AUTH_COOKIE)?.value).toBe("refreshed");
    expect(response.cookies.get(AUTH_COOKIE)?.value).toBe("refreshed");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("removes invalid cookies from the forwarded request", async () => {
    const request = new NextRequest("http://localhost:3000/", { headers: { cookie: `${AUTH_COOKIE}=invalid` } });
    const bridge = createCookieBridge(request.cookies.getAll(), false);
    mock.create.mockReturnValue({ bridge, execute: (operation: () => Promise<unknown>) => operation(), client: { auth: { getClaims: async () => ({ error: { status: 401 } }) } } });
    const response = await updateSession(request);
    expect(request.cookies.has(AUTH_COOKIE)).toBe(false);
    expect(response.cookies.get(AUTH_COOKIE)?.maxAge).toBe(0);
  });
  it("keeps public pages available during an outage without clearing browser cookies", async () => {
    const request = new NextRequest("http://localhost:3000/", { headers: { cookie: `${AUTH_COOKIE}=session` } });
    const bridge = createCookieBridge(request.cookies.getAll(), false);
    mock.create.mockReturnValue({ bridge, execute: (operation: () => Promise<unknown>) => operation(), client: { auth: { getClaims: async () => ({ error: { status: 503 } }) } } });
    const response = await updateSession(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.cookies.getAll()).toEqual([]);
  });
});
