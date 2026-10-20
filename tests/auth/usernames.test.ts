import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { findUsernameAccount, claimUsername, resolveLoginIdentity, usernameForUser } from "@/lib/auth/usernames";
import { loginSchema, signupSchema, usernameSchema, validate } from "@/lib/auth/validation";
const fetchMock = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test_server_only");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("username mapping", () => {
  it("normalizes GitHub-style handles and requires one at signup", () => {
    expect(validate(usernameSchema, " Octo-Cat ")).toBe("octo-cat");
    expect(() => validate(signupSchema, { email: "a@example.com", password: "longpassword" })).toThrow(expect.objectContaining({ fields: { username: expect.any(Array) } }));
  });
  it.each(["-name", "name-", "name--name", "first_last", "a@b", "álvaro", "admin", "A".repeat(40)])("rejects invalid or reserved handle %s", (name) => {
    expect(() => validate(usernameSchema, name)).toThrow();
  });
  it("resolves email privately with the server-only key", async () => {
    fetchMock.mockResolvedValueOnce(json([{ user_id: "verified-uuid", email: "private@example.com" }]));
    expect(await findUsernameAccount("octocat")).toEqual({ id: "verified-uuid", email: "private@example.com" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.supabase.co/rest/v1/rpc/auth_resolve_username");
    expect(JSON.parse(String(init?.body))).toEqual({ requested_username: "octocat" });
    expect(new Headers(init?.headers).get("apikey")).toBe("sb_secret_test_server_only");
  });
  it("does not fabricate a user for an unknown handle", async () => {
    fetchMock.mockResolvedValueOnce(json([]));
    expect(await findUsernameAccount("unknown")).toBeNull();
  });
  it("rejects duplicate mappings rather than choosing an arbitrary account", async () => {
    fetchMock.mockResolvedValueOnce(json([{}, {}]));
    await expect(findUsernameAccount("ambiguous")).rejects.toMatchObject({ code: "USERNAME_UNAVAILABLE" });
  });
  it("supports existing accounts claiming a handle while preventing renaming", async () => {
    fetchMock.mockResolvedValueOnce(json("octocat"));
    expect(await claimUsername("verified-uuid", "octocat")).toBe("octocat");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ account_id: "verified-uuid", requested_username: "octocat" });
    fetchMock.mockResolvedValueOnce(json("existing-name"));
    await expect(claimUsername("verified-uuid", "new-name")).rejects.toMatchObject({ status: 409, code: "USERNAME_ALREADY_SET" });
  });
  it("maps database uniqueness races to an actionable conflict", async () => {
    fetchMock.mockResolvedValueOnce(json({ code: "23505", message: "private DB detail" }, 409));
    await expect(claimUsername("verified-uuid", "taken")).rejects.toMatchObject({ status: 409, code: "USERNAME_TAKEN" });
  });
  it("fails closed when mapping infrastructure is missing", async () => {
    fetchMock.mockResolvedValueOnce(json({ code: "PGRST202", message: "missing function" }, 404));
    await expect(findUsernameAccount("octocat")).rejects.toMatchObject({ status: 503, code: "USERNAME_UNAVAILABLE" });
  });
  it.each(["", "sb_publishable_wrong_key"])("treats a missing or non-admin secret key %j as a setup error without calling Supabase", async (key) => {
    vi.stubEnv("SUPABASE_SECRET_KEY", key);
    await expect(findUsernameAccount("octocat")).rejects.toMatchObject({ status: 503, code: "AUTH_NOT_CONFIGURED" });
    await expect(usernameForUser("verified-uuid")).rejects.toMatchObject({ code: "AUTH_NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("returns null only for accounts without a mapping (created before usernames were required)", async () => {
    fetchMock.mockResolvedValueOnce(json(null));
    expect(await usernameForUser("legacy-uuid")).toBeNull();
  });
});

describe("login identifiers and validation", () => {
  it("resolves a trimmed email without trimming the password or contacting the mapping", async () => {
    const input = validate(loginSchema, { identifier: " person@example.com ", password: " password " });
    expect(input.password).toBe(" password ");
    expect(input.rememberMe).toBe(false);
    await expect(resolveLoginIdentity(input.identifier!)).resolves.toEqual({ email: "person@example.com" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("accepts the email alias for frontend compatibility", () => {
    expect(validate(loginSchema, { email: "person@example.com", password: "x" }).email).toBe("person@example.com");
  });
  it.each([
    { email: "a@example.com", identifier: "b@example.com", password: "secret" },
    { password: "secret" },
    { email: "a@example.com", password: "secret", rememberMe: "false" },
    { email: "a@example.com", password: "secret", role: "admin" },
  ])("rejects ambiguous or untrusted inputs: %j", (input) => {
    expect(() => validate(loginSchema, input)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
  it("resolves normalized usernames through the private mapping without returning emails publicly", async () => {
    fetchMock.mockResolvedValueOnce(json([{ user_id: "stable-id", email: "private@example.com" }]));
    await expect(resolveLoginIdentity(" A-Username ")).resolves.toEqual({ email: "private@example.com", id: "stable-id" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ requested_username: "a-username" });
    fetchMock.mockResolvedValueOnce(json([]));
    await expect(resolveLoginIdentity("unknown-name")).resolves.toBeNull();
    await expect(resolveLoginIdentity("broken@address")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("requires eight characters for signup but permits legacy passwords at login", () => {
    expect(() => validate(signupSchema, { email: "a@example.com", password: "short" })).toThrow();
    expect(validate(loginSchema, { email: "a@example.com", password: "short" }).password).toBe("short");
  });
});
