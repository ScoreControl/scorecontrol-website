import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppOrigin, getAuthConfig, getSecretKey } from "@/lib/auth/config";

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_example");
});
afterEach(() => vi.unstubAllEnvs());

describe("auth configuration", () => {
  it("normalizes the canonical origin and permits loopback development", () => {
    expect(getAuthConfig()).toMatchObject({ origin: "http://localhost:3000", secureCookies: false });
  });
  it("uses secure cookies for HTTPS", () => {
    vi.stubEnv("APP_ORIGIN", "https://scorecontrol.example");
    expect(getAuthConfig().secureCookies).toBe(true);
  });
  it.each(["", "http://public.example", "https://public.example/path", "https://public.example?next=x", "https://user:password@public.example"])("rejects unsafe/missing origins: %s", (origin) => {
    vi.stubEnv("APP_ORIGIN", origin);
    expect(getAppOrigin).toThrow(expect.objectContaining({ code: "AUTH_NOT_CONFIGURED" }));
  });
  const jwt = (role: string) => `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.sig`;
  it.each(["sb_secret_example", jwt("service_role"), jwt("anon"), "random-value"])("rejects publishable key %s unless it is an sb_publishable_ key", (key) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", key);
    expect(getAuthConfig).toThrow(expect.objectContaining({ code: "AUTH_NOT_CONFIGURED" }));
  });
  it.each(["", "sb_publishable_example", jwt("service_role")])("rejects secret key %j unless it is an sb_secret_ key", (key) => {
    vi.stubEnv("SUPABASE_SECRET_KEY", key);
    expect(getSecretKey).toThrow(expect.objectContaining({ code: "AUTH_NOT_CONFIGURED" }));
  });
  it("accepts current-format keys", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_example");
    expect(getSecretKey()).toBe("sb_secret_example");
    expect(getAuthConfig().key).toBe("sb_publishable_example");
  });
});
