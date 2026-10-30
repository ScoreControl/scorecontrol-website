import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth/cookies";
import { handleConfirm, handleGoogleSignIn } from "@/lib/auth/routes";
import * as rateLimit from "@/lib/auth/rate-limit";
import { rateLimited } from "@/lib/auth/errors";

// Real Supabase SDK and cookie adapter; only provider HTTP is mocked.
const userId = "33333333-3333-4333-8333-333333333333";
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function session() {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: userId, aud: "authenticated", exp: expires, iat: expires - 3600, role: "authenticated" })}.sig`;
  return { access_token: token, refresh_token: "refresh", expires_in: 3600, expires_at: expires, token_type: "bearer",
    user: { id: userId, aud: "authenticated", role: "authenticated", email: "musician@gmail.com", app_metadata: { provider: "google" }, user_metadata: {} } };
}
const start = (cookie = "") => handleGoogleSignIn(new NextRequest("http://localhost:3000/api/auth/oauth/google", { headers: { cookie } }));
const cookieHeader = (response: NextResponse) =>
  response.cookies.getAll().filter((cookie) => cookie.maxAge !== 0).map(({ name, value }) => `${name}=${value}`).join("; ");

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Google sign-in", () => {
  it("redirects to the project's Google authorize URL with PKCE and stores the verifier cookie", async () => {
    const response = await start();
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get("location")!);
    expect(target.origin + target.pathname).toBe("https://example.supabase.co/auth/v1/authorize");
    expect(target.searchParams.get("provider")).toBe("google");
    expect(target.searchParams.get("redirect_to")).toBe("http://localhost:3000/auth/confirm");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("code_challenge_method")).toBe("s256");
    const verifier = response.cookies.get(`${AUTH_COOKIE}-code-verifier`);
    expect(verifier).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(response.cookies.has(AUTH_COOKIE)).toBe(false);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finishes at /auth/confirm: exchanges the code with this browser's verifier and signs in", async () => {
    const started = await start();
    fetchMock.mockResolvedValueOnce(json(session()));
    const response = await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?code=google-code",
      { headers: { cookie: cookieHeader(started) } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent).toMatchObject({ auth_code: "google-code" });
    expect(sent.code_verifier).toBeTruthy();
    expect(response.cookies.get(AUTH_COOKIE)?.httpOnly).toBe(true);
    expect(response.cookies.get(AUTH_COOKIE)?.maxAge).toBeUndefined(); // session-only cookie
    expect(response.cookies.get(`${AUTH_COOKIE}-code-verifier`)?.maxAge).toBe(0);
  });

  it("refuses a returned code from a browser that didn't start the sign-in", async () => {
    const response = await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?code=stolen-code"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=confirmation_failed");
    expect(response.cookies.has(AUTH_COOKIE)).toBe(false);
  });

  it("sends a user who cancels at Google back to the login page", async () => {
    const response = await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?error=access_denied&error_description=cancelled"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=confirmation_failed");
  });

  it("redirects to the login page when rate limited, without starting the flow", async () => {
    vi.spyOn(rateLimit, "enforceRateLimit").mockRejectedValue(rateLimited(60));
    const response = await start();
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=rate_limited");
    expect(response.cookies.has(`${AUTH_COOKIE}-code-verifier`)).toBe(false);
  });

  it("returns a configuration error instead of redirecting when auth isn't set up", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const response = await start();
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=unavailable");
  });
});
