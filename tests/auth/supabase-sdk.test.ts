import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createAuthContext, createEphemeralClient } from "@/lib/supabase/server";
import { AUTH_COOKIE, PERSISTENCE_COOKIE, REMEMBER_SECONDS } from "@/lib/auth/cookies";
import { handleConfirm, handleMe } from "@/lib/auth/routes";
import { updateSession } from "@/lib/supabase/proxy";
import { getCurrentUser } from "@/lib/auth/user";
import * as usernameStore from "@/lib/auth/usernames";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
function user(id = firstId) { return { id, aud: "authenticated", role: "authenticated", email: `${id}@example.com`,
  email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" }; }
function session(id = firstId, expires = Math.floor(Date.now() / 1000) + 3600) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, aud: "authenticated", exp: expires, iat: expires - 3600, role: "authenticated" })}.test-signature`;
  return { access_token: jwt, refresh_token: `refresh-${id}`, expires_in: 3600, expires_at: expires, token_type: "bearer", user: user(id) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<typeof fetch>();
function nextRequest(cookies = "") { return new NextRequest("http://localhost:3000/api/auth/me", { headers: { cookie: cookies } }); }
function header(response: NextResponse) {
  return response.cookies.getAll().filter((cookie) => cookie.maxAge !== 0).map(({ name, value }) => `${name}=${value}`).join("; ");
}

beforeEach(() => {
  // Username RPCs have their own tests; keep provider fetch sequences here about auth only.
  vi.spyOn(usernameStore, "usernameForUser").mockResolvedValue(null);
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("real Supabase SDK and cookie adapter (provider HTTP mocked)", () => {
  it.each([false, true])("round-trips an SDK login through cookies, remembered=%s", async (remember) => {
    fetchMock.mockResolvedValueOnce(json(session()));
    const context = createAuthContext(nextRequest());
    context.bridge.setMode(remember);
    const result = await context.client.auth.signInWithPassword({ email: "person@example.com", password: "password" });
    expect(result.error).toBeNull();
    const response = context.bridge.apply(new NextResponse());
    expect(response.cookies.get(AUTH_COOKIE)?.httpOnly).toBe(true);
    expect(response.cookies.get(AUTH_COOKIE)?.maxAge).toBe(remember ? REMEMBER_SECONDS : undefined);
    expect(response.headers.get("cache-control")).toContain("no-store");
    fetchMock.mockResolvedValueOnce(json(user()));
    const next = createAuthContext(nextRequest(header(response)));
    expect(await getCurrentUser(next.client)).toMatchObject({ id: firstId });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("/auth/v1/user");
  });

  it("persists the actual SDK PKCE verifier and exchanges the callback into a session", async () => {
    fetchMock.mockResolvedValueOnce(json(user()));
    const signup = createAuthContext(nextRequest());
    const result = await signup.client.auth.signUp({ email: "person@example.com", password: "password", options: { emailRedirectTo: "http://localhost:3000/auth/confirm" } });
    expect(result.error).toBeNull();
    expect(result.data.session).toBeNull();
    const pending = signup.bridge.apply(new NextResponse());
    expect(pending.cookies.has(`${AUTH_COOKIE}-code-verifier`)).toBe(true);
    expect(pending.cookies.has(AUTH_COOKIE)).toBe(false);
    fetchMock.mockResolvedValueOnce(json(session()));
    const callback = createAuthContext(nextRequest(header(pending)));
    const exchange = await callback.client.auth.exchangeCodeForSession("test-auth-code");
    expect(exchange.error).toBeNull();
    const sent = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(sent.auth_code).toBe("test-auth-code");
    expect(sent.code_verifier).toBeTruthy();
    const confirmed = callback.bridge.apply(new NextResponse());
    expect(confirmed.cookies.get(AUTH_COOKIE)?.httpOnly).toBe(true);
    expect(confirmed.cookies.get(`${AUTH_COOKIE}-code-verifier`)?.maxAge).toBe(0);
  });
  it("rotates an expired session and preserves remember-me on the actual SDK write", async () => {
    const expired = session(firstId, Math.floor(Date.now() / 1000) - 60);
    const encoded = `base64-${Buffer.from(JSON.stringify(expired)).toString("base64url")}`;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes("grant_type=refresh_token")) return json(session());
      if (String(input).endsWith("/auth/v1/user")) return json(user());
      throw new Error("Unexpected provider request");
    });
    const context = createAuthContext(nextRequest(`${AUTH_COOKIE}=${encoded}; ${PERSISTENCE_COOKIE}=remember`));
    expect(await getCurrentUser(context.client)).toMatchObject({ id: firstId });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("grant_type=refresh_token"))).toBe(true);
    const response = context.bridge.apply(new NextResponse());
    expect(response.cookies.get(AUTH_COOKIE)?.maxAge).toBe(REMEMBER_SECONDS);
    expect(response.cookies.get(PERSISTENCE_COOKIE)?.value).toBe("remember");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("round-trips a large chunked session and clears stale chunks on sign-out", async () => {
    const large = session();
    large.user.user_metadata = { bio: "a".repeat(6500) };
    fetchMock.mockResolvedValueOnce(json(large));
    const context = createAuthContext(nextRequest());
    await context.client.auth.signInWithPassword({ email: "person@example.com", password: "password" });
    const response = context.bridge.apply(new NextResponse());
    expect(response.cookies.get(`${AUTH_COOKIE}.0`)).toBeDefined();
    fetchMock.mockResolvedValueOnce(json(user()));
    const next = createAuthContext(nextRequest(header(response)));
    expect(await getCurrentUser(next.client)).toMatchObject({ id: firstId });
    next.bridge.clear(true);
    const cleared = next.bridge.apply(new NextResponse());
    expect(cleared.cookies.get(`${AUTH_COOKIE}.1`)?.maxAge).toBe(0);
  });
  it("does not authenticate a forged cookie when the provider rejects the token", async () => {
    const encoded = `base64-${Buffer.from(JSON.stringify(session())).toString("base64url")}`;
    fetchMock.mockResolvedValue(json({ code: "bad_jwt", msg: "Invalid token" }, 401));
    const context = createAuthContext(nextRequest(`${AUTH_COOKIE}=${encoded}`));
    expect(await getCurrentUser(context.client)).toBeNull();
  });
  it("never shares authenticated state between concurrent SDK clients", async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      return json(session(body.email === "a@example.com" ? firstId : secondId));
    });
    const a = createAuthContext(nextRequest());
    const b = createAuthContext(nextRequest());
    await Promise.all([
      a.client.auth.signInWithPassword({ email: "a@example.com", password: "password" }),
      b.client.auth.signInWithPassword({ email: "b@example.com", password: "password" }),
    ]);
    expect(a.bridge.getAll().find(({ name }) => name === AUTH_COOKIE)?.value)
      .not.toBe(b.bridge.getAll().find(({ name }) => name === AUTH_COOKIE)?.value);
  });
});

describe("successful refresh followed by provider outage", () => {
  it.each(["api", "public page"])("keeps rotated credentials on a %s request", async (kind) => {
    const expired = session(firstId, Math.floor(Date.now() / 1000) - 60);
    const rotated = { ...session(), refresh_token: "rotated-new-token" };
    const encoded = `base64-${Buffer.from(JSON.stringify(expired)).toString("base64url")}`;
    fetchMock.mockImplementation(async (input) => String(input).includes("grant_type=refresh_token")
      ? json(rotated) : json({ message: "Temporary outage" }, 503));
    const request = nextRequest(`${AUTH_COOKIE}=${encoded}; ${PERSISTENCE_COOKIE}=remember`);
    const response = await (kind === "api" ? handleMe(request) : updateSession(request));
    expect(response.status).toBe(kind === "api" ? 503 : 200);
    if (kind === "public page") expect(response.headers.get("x-middleware-next")).toBe("1");
    const value = response.cookies.get(AUTH_COOKIE)!.value;
    const saved = JSON.parse(Buffer.from(value.replace(/^base64-/, ""), "base64url").toString());
    expect(saved.refresh_token).toBe("rotated-new-token");
    expect(response.cookies.get(AUTH_COOKIE)?.maxAge).toBe(REMEMBER_SECONDS);
  });
});

it("returns within five seconds even while the SDK is backing off refresh failures", async () => {
  vi.useFakeTimers();
  const expired = session(firstId, Math.floor(Date.now() / 1000) - 60);
  const encoded = `base64-${Buffer.from(JSON.stringify(expired)).toString("base64url")}`;
  fetchMock.mockResolvedValue(json({ message: "Provider unavailable" }, 503));
  const result = handleMe(nextRequest(`${AUTH_COOKIE}=${encoded}`));
  await vi.advanceTimersByTimeAsync(5000);
  const response = await result;
  expect(response.status).toBe(503);
  expect(response.cookies.getAll()).toEqual([]);
  const attempts = fetchMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(35000);
  expect(fetchMock.mock.calls.length).toBe(attempts);
});

it("blocks late cookie writes even if a provider transport ignores cancellation", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 6000)); return json(session()); });
  const context = createAuthContext(nextRequest());
  const result = context.execute(() => context.client.auth.signInWithPassword({ email: "person@example.com", password: "password" }));
  const assertion = expect(result).rejects.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
  await vi.advanceTimersByTimeAsync(2000);
  expect(context.bridge.apply(new NextResponse()).cookies.getAll()).toEqual([]);
});

describe("password recovery and email links through the real SDK", () => {
  it("returns redirectType for a same-browser PKCE recovery so the callback can route to the reset page", async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    const start = createAuthContext(nextRequest());
    const sent = await start.client.auth.resetPasswordForEmail("person@example.com", { redirectTo: "http://localhost:3000/auth/confirm" });
    expect(sent.error).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).code_challenge).toBeTruthy();
    const pending = start.bridge.apply(new NextResponse());
    fetchMock.mockResolvedValueOnce(json(session()));
    const response = await handleConfirm(new NextRequest(`http://localhost:3000/auth/confirm?code=recovery-code`,
      { headers: { cookie: header(pending) } }));
    expect(response.headers.get("location")).toBe("http://localhost:3000/reset-password");
    expect(response.cookies.get(AUTH_COOKIE)?.httpOnly).toBe(true);
  });
  it("verifies a token-hash link in memory and revokes that session instead of setting cookies", async () => {
    fetchMock.mockImplementation(async (input) => String(input).includes("/auth/v1/verify") ? json(session()) : new Response(null, { status: 204 }));
    const response = await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?token_hash=abc123&type=email"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?status=email_confirmed");
    expect(response.cookies.getAll()).toEqual([]);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("/auth/v1/logout?scope=local"))).toBe(true);
    const logout = fetchMock.mock.calls.find(([url]) => String(url).includes("/logout"));
    expect(new Headers(logout?.[1]?.headers).get("authorization")).toBe(`Bearer ${session().access_token}`);
  });
  it("keeps ephemeral sessions isolated from each other", async () => {
    fetchMock.mockImplementation(async (_input, init) => json(session(JSON.parse(String(init?.body)).email === "a@example.com" ? firstId : secondId)));
    const a = createEphemeralClient();
    const b = createEphemeralClient();
    await a.auth.signInWithPassword({ email: "a@example.com", password: "password" });
    await b.auth.signInWithPassword({ email: "b@example.com", password: "password" });
    expect((await a.auth.getSession()).data.session?.user.id).toBe(firstId);
    expect((await b.auth.getSession()).data.session?.user.id).toBe(secondId);
  });
});
