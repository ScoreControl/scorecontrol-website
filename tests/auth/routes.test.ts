import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createCookieBridge, AUTH_COOKIE } from "@/lib/auth/cookies";

const mocks = vi.hoisted(() => ({ createContext: vi.fn(), createEphemeral: vi.fn(), rateLimit: vi.fn(), subjectLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAuthContext: mocks.createContext, createEphemeralClient: mocks.createEphemeral, createReadOnlyClient: vi.fn() }));
vi.mock("@/lib/auth/rate-limit", () => ({ enforceRateLimit: mocks.rateLimit, enforceSubjectLimit: mocks.subjectLimit }));
import { handleChangePassword, handleConfirm, handleClaimUsername, handleForgotPassword, handleResetPassword, handleLogin, handleLogout, handleMe, handleResend, handleSignup } from "@/lib/auth/routes";
import * as usernameStore from "@/lib/auth/usernames";
import { AuthHttpError } from "@/lib/auth/errors";
import { requireUser } from "@/lib/auth/user";

const user = { id: "user-uuid", email: "person@example.com", email_confirmed_at: "2026-01-01", user_metadata: { role: "admin", secret: "hidden" } } as unknown as User;
const auth = { signUp: vi.fn(), signInWithPassword: vi.fn(), getUser: vi.fn(), signOut: vi.fn(), resend: vi.fn(),
  exchangeCodeForSession: vi.fn(), verifyOtp: vi.fn(), resetPasswordForEmail: vi.fn(), updateUser: vi.fn(), getSession: vi.fn() };
const ephemeral = { verifyOtp: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() };
let bridge: ReturnType<typeof createCookieBridge>;
let resolveIdentity: MockInstance<typeof usernameStore.resolveLoginIdentity>;
const request = (path: string, body: unknown = {}, cookies = "") => new NextRequest(`http://localhost:3000${path}`, {
  method: "POST", body: JSON.stringify(body), headers: { origin: "http://localhost:3000", "content-type": "application/json", cookie: cookies },
});

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.spyOn(console, "error").mockImplementation(() => {});
  bridge = createCookieBridge([], false);
  mocks.createContext.mockImplementation(() => ({ client: { auth }, bridge, execute: (operation: () => Promise<unknown>) => operation() }));
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.subjectLimit.mockResolvedValue(undefined);
  resolveIdentity = vi.spyOn(usernameStore, "resolveLoginIdentity").mockResolvedValue({ email: "person@example.com" });
  vi.spyOn(usernameStore, "findUsernameAccount").mockResolvedValue(null);
  vi.spyOn(usernameStore, "usernameForUser").mockResolvedValue("octo-cat");
  for (const method of [...Object.values(auth), ...Object.values(ephemeral)]) method.mockReset();
  mocks.createEphemeral.mockReturnValue({ auth: ephemeral });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("signup", () => {
  it("creates an account through Supabase and returns only safe user fields", async () => {
    auth.signUp.mockResolvedValue({ data: { user, session: {} }, error: null });
    const response = await handleSignup(request("/api/auth/signup", { email: user.email, password: "long-password", username: "octo-cat" }));
    expect(response.status).toBe(201);
    expect(auth.signUp).toHaveBeenCalledWith({ email: user.email, password: "long-password",
      options: { emailRedirectTo: "http://localhost:3000/auth/confirm", data: { scorecontrol_username: "octo-cat" } } });
    expect(await response.json()).toEqual({ data: { status: "authenticated", user: { id: user.id, email: user.email, emailVerified: true, username: "octo-cat" } } });
  });
  it("does not treat a pending user object as an authenticated session", async () => {
    auth.signUp.mockResolvedValue({ data: { user, session: null }, error: null });
    const response = await handleSignup(request("/api/auth/signup", { email: user.email, password: "long-password", username: "octo-cat" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { status: "confirmation_required" } });
    expect(response.cookies.has("sc-auth-persistence")).toBe(false);
  });
  it("normalizes duplicate-account errors to the same pending response", async () => {
    auth.signUp.mockResolvedValue({ data: {}, error: { status: 400, code: "user_already_exists" } });
    expect((await handleSignup(request("/api/auth/signup", { email: user.email, password: "long-password", username: "octo-cat" }))).status).toBe(202);
  });
  it("rejects validation and origin errors before creating a provider client", async () => {
    mocks.createContext.mockClear();
    const invalid = request("/api/auth/signup", { email: "bad", password: "short" });
    expect((await handleSignup(invalid)).status).toBe(400);
    expect((await handleSignup(request("/api/auth/signup", { email: user.email, password: "long-password" }))).status).toBe(400);
    const crossSite = request("/api/auth/signup", { email: user.email, password: "long-password", username: "octo-cat" });
    crossSite.headers.set("origin", "https://evil.example");
    expect((await handleSignup(crossSite)).status).toBe(403);
    expect(mocks.createContext).not.toHaveBeenCalled();
  });
});

describe("login", () => {
  it("uses the identity resolver so usernames can be added without changing session code", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { user, session: { access_token: "never-return" } }, error: null });
    const response = await handleLogin(request("/api/auth/login", { identifier: "person@example.com", password: " password ", rememberMe: true }));
    expect(resolveIdentity).toHaveBeenCalledWith("person@example.com");
    expect(mocks.subjectLimit).toHaveBeenCalledWith("login", "person@example.com");
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "person@example.com", password: " password " });
    expect(response.cookies.get("sc-auth-persistence")?.maxAge).toBe(30 * 86400);
    expect(JSON.stringify(await response.json())).not.toContain("never-return");
  });
  it("applies the per-account quota to the resolved email before contacting the provider", async () => {
    resolveIdentity.mockResolvedValue({ email: "private@example.com", id: "user-uuid" });
    mocks.subjectLimit.mockRejectedValue(new AuthHttpError(429, "RATE_LIMITED", "Wait", undefined, 60));
    const response = await handleLogin(request("/api/auth/login", { identifier: "octocat", password: "secret" }));
    expect(response.status).toBe(429);
    expect(mocks.subjectLimit).toHaveBeenCalledWith("login", "private@example.com");
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
  it("returns the same credential error for an unknown resolved identity", async () => {
    resolveIdentity.mockResolvedValue(null);
    const response = await handleLogin(request("/api/auth/login", { identifier: "unknown@example.com", password: "wrong" }));
    expect(response.status).toBe(401);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
  it.each([
    [{ status: 400, code: "invalid_credentials" }, 401, "INVALID_CREDENTIALS"],
    [{ status: 400, code: "email_not_confirmed" }, 403, "EMAIL_NOT_CONFIRMED"],
    [{ status: 429 }, 429, "RATE_LIMITED"],
    [{ status: 503 }, 503, "AUTH_UNAVAILABLE"],
  ])("maps provider failures without leaking their messages", async (error, status, code) => {
    auth.signInWithPassword.mockResolvedValue({ data: {}, error: { ...error, message: "secret-provider-details" } });
    const response = await handleLogin(request("/api/auth/login", { email: user.email, password: "wrong" }));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("secret-provider-details");
  });
  it("discards partial SDK writes on a failed login", async () => {
    auth.signInWithPassword.mockImplementation(async () => {
      bridge.setAll([{ name: AUTH_COOKIE, value: "partial", options: {} }]);
      return { data: {}, error: { status: 400, code: "invalid_credentials" } };
    });
    const response = await handleLogin(request("/api/auth/login", { email: user.email, password: "wrong" }));
    expect(response.cookies.getAll()).toEqual([]);
  });
});

describe("current user and backend guard", () => {
  beforeEach(() => { bridge = createCookieBridge([{ name: AUTH_COOKIE, value: "session" }], false); });
  it("uses provider-confirmed identity rather than trusting cookie contents", async () => {
    auth.getUser.mockResolvedValue({ data: { user }, error: null });
    const response = await handleMe(new NextRequest("http://localhost:3000/api/auth/me"));
    expect(response.status).toBe(200);
    expect(auth.getUser).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ data: { user: { id: user.id, email: user.email, emailVerified: true, username: "octo-cat" } } });
  });
  it("clears an invalid session", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { status: 400, code: "refresh_token_not_found" } });
    const response = await handleMe(new NextRequest("http://localhost:3000/api/auth/me"));
    expect(response.status).toBe(401);
    expect(response.cookies.get(AUTH_COOKIE)?.maxAge).toBe(0);
  });
  it("preserves credentials through temporary outages", async () => {
    auth.getUser.mockImplementation(async () => {
      bridge.clear();
      return { data: { user: null }, error: { status: 503 } };
    });
    const response = await handleMe(new NextRequest("http://localhost:3000/api/auth/me"));
    expect(response.status).toBe(503);
    expect(response.cookies.getAll()).toEqual([]);
    expect(bridge.hasSession()).toBe(true);
  });
  it("rejects requests without cookies without asking Supabase", async () => {
    bridge = createCookieBridge([], false);
    expect((await handleMe(new NextRequest("http://localhost:3000/api/auth/me"))).status).toBe(401);
    expect(auth.getUser).not.toHaveBeenCalled();
  });
  it("the shared guard rejects unauthenticated backend consumers", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError" } });
    const client = { auth } as unknown as Parameters<typeof requireUser>[0];
    await expect(requireUser(client)).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });
});

describe("logout", () => {
  it("explicitly revokes only the current session and clears cookies", async () => {
    bridge = createCookieBridge([{ name: `${AUTH_COOKIE}.0`, value: "part0" }, { name: `${AUTH_COOKIE}.1`, value: "part1" }], false);
    auth.signOut.mockResolvedValue({ error: null });
    const response = await handleLogout(request("/api/auth/logout"));
    expect(response.status).toBe(204);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.cookies.get(`${AUTH_COOKIE}.1`)?.maxAge).toBe(0);
    expect(response.cookies.get("sc-auth-persistence")?.maxAge).toBe(0);
  });
  it("is idempotent when already signed out", async () => {
    expect((await handleLogout(request("/api/auth/logout"))).status).toBe(204);
    expect(auth.signOut).not.toHaveBeenCalled();
  });
  it("still clears local cookies when provider revocation fails", async () => {
    bridge = createCookieBridge([{ name: AUTH_COOKIE, value: "session" }], false);
    auth.signOut.mockResolvedValue({ error: { status: 503 } });
    const response = await handleLogout(request("/api/auth/logout"));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("LOGOUT_INCOMPLETE");
    expect(response.cookies.get(AUTH_COOKIE)?.maxAge).toBe(0);
  });
});

describe("resend and email callbacks", () => {
  it("returns a generic accepted response for unknown addresses", async () => {
    auth.resend.mockResolvedValue({ error: { status: 404, code: "user_not_found" } });
    const response = await handleResend(request("/api/auth/resend-confirmation", { email: user.email }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { status: "accepted" } });
  });
  it("exchanges only the supplied code and ignores arbitrary redirect destinations", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: { user, session: {} }, error: null });
    const response = await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?code=valid-code&next=https://evil.example"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("valid-code");
  });
  it.each(["", "?code=", "?code=a&code=b", "?error=access_denied&code=x"])("rejects invalid callback %s", async (query) => {
    const response = await handleConfirm(new NextRequest(`http://localhost:3000/auth/confirm${query}`));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=confirmation_failed");
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });
  it("does not leak expired callback codes or provider error messages", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: { status: 400, message: "sensitive" } });
    const response = await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?code=expired-secret"));
    expect(response.headers.get("location")).not.toContain("expired-secret");
    expect(response.cookies.getAll()).toEqual([]);
  });

  it("preserves verification cookies and redirects callback provider outages to a retryable notice", async () => {
    auth.exchangeCodeForSession.mockImplementation(async () => {
      bridge.setAll([{ name: `${AUTH_COOKIE}-code-verifier`, value: "", options: { maxAge: 0 } }]);
      return { data: {}, error: { status: 503 } };
    });
    const response = await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?code=test-code"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=unavailable");
    expect(response.cookies.getAll()).toEqual([]);
  });
  it("redirects a throttled callback instead of returning JSON to a browser navigation", async () => {
    mocks.rateLimit.mockRejectedValue(new AuthHttpError(429, "RATE_LIMITED", "Wait", undefined, 60));
    const response = await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?code=test-code"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=rate_limited");
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });
  it("does not create a provider client when rate limited", async () => {
    mocks.createContext.mockClear();
    mocks.rateLimit.mockRejectedValue(new AuthHttpError(429, "RATE_LIMITED", "Wait", undefined, 60));
    const response = await handleLogin(request("/api/auth/login", { email: user.email, password: "secret" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(mocks.createContext).not.toHaveBeenCalled();
  });
});

describe("username routes", () => {
  it("submits a normalized signup handle for atomic registration by the schema-owned trigger", async () => {
    auth.signUp.mockResolvedValue({ data: { user, session: {} }, error: null });
    const response = await handleSignup(request("/api/auth/signup", { email: user.email, password: "long-password", username: "Octo-Cat" }));
    expect(response.status).toBe(201);
    expect(auth.signUp.mock.calls[0][0].options.data).toEqual({ scorecontrol_username: "octo-cat" });
    expect((await response.json()).data.user.username).toBe("octo-cat");
  });
  it("rejects a taken username before creating the account", async () => {
    vi.spyOn(usernameStore, "findUsernameAccount").mockResolvedValue({ id: "owner", email: "private@example.com" });
    const response = await handleSignup(request("/api/auth/signup", { email: user.email, password: "long-password", username: "octocat" }));
    expect(response.status).toBe(409);
    expect(auth.signUp).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("private@example.com");
  });
  it("reports a concurrent signup winner without accepting a duplicate handle", async () => {
    vi.spyOn(usernameStore, "findUsernameAccount").mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "winner", email: "private@example.com" });
    auth.signUp.mockResolvedValue({ data: {}, error: { status: 500 } });
    const response = await handleSignup(request("/api/auth/signup", { email: user.email, password: "long-password", username: "octocat" }));
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("private@example.com");
  });
  it("requires the resolved UUID to match the provider-authenticated account", async () => {
    resolveIdentity.mockResolvedValue({ email: user.email!, id: "different-uuid" });
    auth.signInWithPassword.mockResolvedValue({ data: { user, session: {} }, error: null });
    auth.signOut.mockResolvedValue({ error: null });
    const response = await handleLogin(request("/api/auth/login", { identifier: "octocat", password: "long-password" }));
    expect(response.status).toBe(401);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.cookies.getAll()).toEqual([]);
  });
  it("uses only the verified user ID when claiming a username", async () => {
    auth.getUser.mockResolvedValue({ data: { user }, error: null });
    const claim = vi.spyOn(usernameStore, "claimUsername").mockResolvedValue("octocat");
    expect((await handleClaimUsername(request("/api/auth/username", { username: "Octocat", userId: "attacker-id" }))).status).toBe(400);
    const response = await handleClaimUsername(request("/api/auth/username", { username: "Octocat" }));
    expect(response.status).toBe(200);
    expect(claim).toHaveBeenCalledWith(user.id, "octocat");
  });
});

it("keeps a successful sign-in if later username enrichment fails", async () => {
  vi.spyOn(usernameStore, "usernameForUser").mockRejectedValue(new AuthHttpError(503, "USERNAME_UNAVAILABLE", "Unavailable"));
  auth.signInWithPassword.mockImplementation(async () => {
    bridge.setAll([{ name: AUTH_COOKIE, value: "successful-session", options: {} }]);
    return { data: { user, session: {} }, error: null };
  });
  const response = await handleLogin(request("/api/auth/login", { email: user.email, password: "password" }));
  expect(response.status).toBe(503);
  expect(response.cookies.get(AUTH_COOKIE)?.value).toBe("successful-session");
});

describe("cross-device email links", () => {
  it("confirms a token-hash signup link without signing this browser in", async () => {
    ephemeral.verifyOtp.mockResolvedValue({ data: { user, session: { access_token: "t" } }, error: null });
    ephemeral.signOut.mockResolvedValue({ error: null });
    const response = await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?token_hash=abc123&type=email"));
    expect(ephemeral.verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "abc123" });
    expect(ephemeral.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?status=email_confirmed");
    expect(response.cookies.getAll()).toEqual([]);
    expect(mocks.createContext).not.toHaveBeenCalled();
  });
  it("reports expired token-hash links and outages distinctly", async () => {
    ephemeral.verifyOtp.mockResolvedValue({ data: {}, error: { status: 403, code: "otp_expired" } });
    expect((await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?token_hash=abc&type=email"))).headers.get("location"))
      .toBe("http://localhost:3000/login?error=confirmation_failed");
    ephemeral.verifyOtp.mockResolvedValue({ data: {}, error: { status: 503 } });
    expect((await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?token_hash=abc&type=email"))).headers.get("location"))
      .toBe("http://localhost:3000/login?error=unavailable");
  });
  it.each(["?token_hash=abc&type=magiclink", "?token_hash=a%20b&type=email", "?token_hash=a&token_hash=b&type=email", "?token_hash=abc"])(
    "rejects malformed token-hash link %s", async (query) => {
      const response = await handleConfirm(new NextRequest(`http://localhost:3000/auth/confirm${query}`));
      expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=confirmation_failed");
      expect(ephemeral.verifyOtp).not.toHaveBeenCalled();
    });
  it.each(["recovery", "signup"])("rejects type=%s token-hash links without verifying them", async (type) => {
    // Reset emails link straight to the reset page fragment; signup links use type=email.
    const response = await handleConfirm(new NextRequest(`http://localhost:3000/auth/confirm?token_hash=abc123&type=${type}`));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=confirmation_failed");
    expect(ephemeral.verifyOtp).not.toHaveBeenCalled();
  });
  it("sends a same-browser PKCE recovery exchange to the reset page", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: { user, session: {}, redirectType: "recovery" }, error: null });
    const response = await handleConfirm(new NextRequest("http://localhost:3000/auth/confirm?code=recovery-code"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/reset-password");
  });
});

describe("password recovery and change", () => {
  const jwt = (amr: unknown) => `h.${Buffer.from(JSON.stringify({ sub: user.id, amr })).toString("base64url")}.s`;
  beforeEach(() => { bridge = createCookieBridge([{ name: AUTH_COOKIE, value: "session" }], false); });

  it("requests a recovery email with a generic response and the fixed callback", async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    const response = await handleForgotPassword(request("/api/auth/forgot-password", { email: user.email }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { status: "accepted" } });
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.anything(), "recover", user.email);
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(user.email, { redirectTo: "http://localhost:3000/auth/confirm" });
    const crossSite = request("/api/auth/forgot-password", { email: user.email });
    crossSite.headers.set("origin", "https://evil.example");
    expect((await handleForgotPassword(crossSite)).status).toBe(403);
  });
  it("resets a password from a recovery token and revokes other sessions", async () => {
    auth.verifyOtp.mockImplementation(async () => {
      bridge.setAll([{ name: AUTH_COOKIE, value: "recovery-session", options: {} }]);
      return { data: { user, session: {} }, error: null };
    });
    auth.updateUser.mockResolvedValue({ data: { user }, error: null });
    auth.signOut.mockResolvedValue({ error: null });
    const response = await handleResetPassword(request("/api/auth/reset-password", { tokenHash: "abc123", password: "new-long-password" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status: "password_updated", otherSessionsRevoked: true } });
    expect(auth.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "abc123" });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "new-long-password" });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "others" });
    expect(response.cookies.get(AUTH_COOKIE)?.value).toBe("recovery-session");
  });
  it("rejects a short password before consuming the single-use token", async () => {
    const response = await handleResetPassword(request("/api/auth/reset-password", { tokenHash: "abc123", password: "short" }));
    expect(response.status).toBe(400);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("reports invalid recovery links without leaking provider details", async () => {
    auth.verifyOtp.mockResolvedValue({ data: {}, error: { status: 403, code: "otp_expired", message: "sensitive" } });
    const response = await handleResetPassword(request("/api/auth/reset-password", { tokenHash: "abc123", password: "new-long-password" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("RECOVERY_LINK_INVALID");
    expect(JSON.stringify(body)).not.toContain("sensitive");
  });
  it("keeps the recovery session when the provider rejects the new password, so it can be retried", async () => {
    auth.verifyOtp.mockImplementation(async () => {
      bridge.setAll([{ name: AUTH_COOKIE, value: "recovery-session", options: {} }]);
      return { data: { user, session: {} }, error: null };
    });
    auth.updateUser.mockResolvedValue({ data: {}, error: { status: 422, code: "weak_password" } });
    const response = await handleResetPassword(request("/api/auth/reset-password", { tokenHash: "abc123", password: "new-long-password" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("WEAK_PASSWORD");
    expect(response.cookies.get(AUTH_COOKIE)?.value).toBe("recovery-session");
  });
  it("requires the current password for an ordinary session", async () => {
    auth.getUser.mockResolvedValue({ data: { user }, error: null });
    auth.getSession.mockResolvedValue({ data: { session: { access_token: jwt([{ method: "password", timestamp: Date.now() / 1000 }]) } } });
    const response = await handleChangePassword(request("/api/auth/password", { password: "new-long-password" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("CURRENT_PASSWORD_REQUIRED");
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it("verifies the current password out of band and rejects a wrong one", async () => {
    auth.getUser.mockResolvedValue({ data: { user }, error: null });
    auth.getSession.mockResolvedValue({ data: { session: { access_token: jwt([{ method: "password", timestamp: 0 }]) } } });
    ephemeral.signInWithPassword.mockResolvedValue({ data: {}, error: { status: 400, code: "invalid_credentials" } });
    const response = await handleChangePassword(request("/api/auth/password", { password: "new-long-password", currentPassword: "wrong" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_CURRENT_PASSWORD");
    expect(mocks.subjectLimit).toHaveBeenCalledWith("login", user.email);
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(response.cookies.get(AUTH_COOKIE)?.maxAge).not.toBe(0);
  });
  it("changes the password after verifying the current one and revokes the extra session", async () => {
    auth.getUser.mockResolvedValue({ data: { user }, error: null });
    auth.getSession.mockResolvedValue({ data: { session: { access_token: jwt([{ method: "password", timestamp: 0 }]) } } });
    ephemeral.signInWithPassword.mockResolvedValue({ data: { user, session: {} }, error: null });
    ephemeral.signOut.mockResolvedValue({ error: null });
    auth.updateUser.mockResolvedValue({ data: { user }, error: null });
    auth.signOut.mockResolvedValue({ error: null });
    const response = await handleChangePassword(request("/api/auth/password", { password: "new-long-password", currentPassword: "old-password" }));
    expect(response.status).toBe(200);
    expect(ephemeral.signInWithPassword).toHaveBeenCalledWith({ email: user.email, password: "old-password" });
    expect(ephemeral.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "others" });
  });
  it("skips the current password only right after a recovery sign-in", async () => {
    auth.getUser.mockResolvedValue({ data: { user }, error: null });
    auth.updateUser.mockResolvedValue({ data: { user }, error: null });
    auth.signOut.mockResolvedValue({ error: { status: 503 } });
    auth.getSession.mockResolvedValue({ data: { session: { access_token: jwt([{ method: "recovery", timestamp: Date.now() / 1000 - 60 }]) } } });
    const recent = await handleChangePassword(request("/api/auth/password", { password: "new-long-password" }));
    expect(recent.status).toBe(200);
    expect(await recent.json()).toEqual({ data: { status: "password_updated", otherSessionsRevoked: false } });
    auth.getSession.mockResolvedValue({ data: { session: { access_token: jwt([{ method: "recovery", timestamp: Date.now() / 1000 - 3600 }]) } } });
    expect((await handleChangePassword(request("/api/auth/password", { password: "new-long-password" }))).status).toBe(400);
    expect(ephemeral.signInWithPassword).not.toHaveBeenCalled();
  });
  it("requires a verified session", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError" } });
    const response = await handleChangePassword(request("/api/auth/password", { password: "new-long-password", currentPassword: "x" }));
    expect(response.status).toBe(401);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});
