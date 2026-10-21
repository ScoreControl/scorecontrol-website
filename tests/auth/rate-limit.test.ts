import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ limit: vi.fn(), redis: vi.fn() }));
vi.mock("@upstash/ratelimit", () => ({ Ratelimit: class {
  static slidingWindow() { return {}; }
  limit = mocks.limit;
} }));
vi.mock("@upstash/redis", () => ({ Redis: class { constructor(options: unknown) { mocks.redis(options); } } }));
let enforce: typeof import("@/lib/auth/rate-limit").enforceRateLimit;
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("AUTH_TRUSTED_IP_HEADER", "");
  enforce = (await import("@/lib/auth/rate-limit")).enforceRateLimit;
  mocks.limit.mockResolvedValue({ success: true, pending: Promise.resolve(), reset: Date.now() + 60000 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const request = (headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/auth/login", { headers });

describe("auth rate limiting", () => {
  it("requires a real trusted single-IP header in production instead of a shared user bucket", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    await expect(enforce(request(), "signup")).rejects.toMatchObject({ code: "CLIENT_IP_UNAVAILABLE" });
    vi.stubEnv("AUTH_TRUSTED_IP_HEADER", "x-real-ip");
    await expect(enforce(request(), "signup")).rejects.toMatchObject({ code: "CLIENT_IP_UNAVAILABLE" });
    await expect(enforce(request({ "x-real-ip": "192.0.2.1, 192.0.2.2" }), "signup")).rejects.toMatchObject({ code: "CLIENT_IP_UNAVAILABLE" });
    mocks.limit.mockClear();
    await enforce(request({ "x-real-ip": "192.0.2.1" }), "signup");
    await enforce(request({ "x-real-ip": "192.0.2.2" }), "signup");
    const keys = mocks.limit.mock.calls.map(([key]) => key);
    expect(keys[0]).not.toBe(keys[2]); // Independent client quotas, checked first.
    expect(keys[1]).toBe(keys[3]); // Deliberate high global ceiling, checked last.
  });
  it("enforces the local quota and expires windows", async () => {
    vi.useFakeTimers();
    for (let n = 0; n < 5; n++) await enforce(request(), "signup");
    await expect(enforce(request(), "signup")).rejects.toMatchObject({ status: 429, retryAfter: 3600 });
    vi.advanceTimersByTime(3600001);
    await expect(enforce(request(), "signup")).resolves.toBeUndefined();
  });
  it("does not trust spoofed forwarded headers by default", async () => {
    for (let n = 0; n < 5; n++) await enforce(request({ "x-forwarded-for": `192.0.2.${n}` }), "signup");
    await expect(enforce(request({ "x-forwarded-for": "192.0.2.99" }), "signup")).rejects.toMatchObject({ status: 429 });
  });
  it("uses only explicitly trusted single-IP headers", async () => {
    vi.stubEnv("AUTH_TRUSTED_IP_HEADER", "x-real-ip");
    for (let n = 0; n < 5; n++) await enforce(request({ "x-real-ip": "192.0.2.1" }), "signup");
    await expect(enforce(request({ "x-real-ip": "192.0.2.2" }), "signup")).resolves.toBeUndefined();
  });
  it("limits repeated confirmation emails independently of source IP", async () => {
    vi.stubEnv("AUTH_TRUSTED_IP_HEADER", "x-real-ip");
    for (let n = 0; n < 3; n++) await enforce(request({ "x-real-ip": `192.0.2.${n}` }), "resend", "person@example.com");
    await expect(enforce(request({ "x-real-ip": "192.0.2.99" }), "resend", "Person@example.com")).rejects.toMatchObject({ status: 429 });
  });
  it("fails closed without shared storage in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(enforce(request(), "login")).rejects.toMatchObject({ status: 503, code: "CLIENT_IP_UNAVAILABLE" });
  });

  it("reports invalid Redis endpoints as setup errors instead of trying to connect", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    await expect(enforce(request(), "login")).rejects.toMatchObject({ status: 503, code: "RATE_LIMIT_NOT_CONFIGURED" });
  });
  it("reports malformed trusted-header configuration safely", async () => {
    vi.stubEnv("AUTH_TRUSTED_IP_HEADER", "bad header");
    await expect(enforce(request(), "login")).rejects.toMatchObject({ status: 503, code: "RATE_LIMIT_NOT_CONFIGURED" });
  });
  it("uses shared storage without putting raw IPs/emails into keys", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubEnv("AUTH_TRUSTED_IP_HEADER", "x-real-ip");
    await enforce(request({ "x-real-ip": "192.0.2.1" }), "resend", "private@example.com");
    expect(mocks.redis).toHaveBeenCalled();
    for (const [key] of mocks.limit.mock.calls) expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
  it("does not let one throttled client exhaust the shared global ceiling", async () => {
    vi.stubEnv("AUTH_TRUSTED_IP_HEADER", "x-real-ip");
    for (let n = 0; n < 5; n++) await enforce(request({ "x-real-ip": "192.0.2.1" }), "signup");
    // Far more rejected attempts than the global ceiling (5 x 1000) would allow if they counted.
    for (let n = 0; n < 6000; n++) await expect(enforce(request({ "x-real-ip": "192.0.2.1" }), "signup")).rejects.toMatchObject({ status: 429 });
    await expect(enforce(request({ "x-real-ip": "192.0.2.2" }), "signup")).resolves.toBeUndefined();
  });
  it("limits login attempts per account across source IPs", async () => {
    const { enforceSubjectLimit } = await import("@/lib/auth/rate-limit");
    for (let n = 0; n < 10; n++) await enforceSubjectLimit("login", "person@example.com");
    await expect(enforceSubjectLimit("login", " Person@Example.com ")).rejects.toMatchObject({ status: 429 });
    await expect(enforceSubjectLimit("login", "other@example.com")).resolves.toBeUndefined();
  });
  it("converts SDK timeouts into an outage instead of allowing a login", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    mocks.limit.mockResolvedValue({ success: true, reason: "timeout", pending: Promise.resolve() });
    await expect(enforce(request(), "login")).rejects.toMatchObject({ status: 503, code: "RATE_LIMIT_UNAVAILABLE" });
  });
  it("returns retry timing for a distributed quota failure", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    mocks.limit.mockResolvedValue({ success: false, pending: Promise.resolve(), reset: Date.now() + 60000 });
    await expect(enforce(request(), "login")).rejects.toMatchObject({ status: 429 });
  });
});
