import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES, authJson, errorResponse, readJson } from "@/lib/auth/http";
import { AuthHttpError } from "@/lib/auth/errors";

beforeEach(() => vi.stubEnv("APP_ORIGIN", "http://localhost:3000"));
afterEach(() => vi.unstubAllEnvs());
const request = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/auth/login", {
  method: "POST", body, headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers },
});

describe("auth HTTP boundary", () => {
  it("reads JSON with a charset", async () => {
    expect(await readJson(request('{"ok":true}', { "content-type": "application/json; charset=utf-8" }))).toEqual({ ok: true });
  });
  it.each(["https://evil.example", "null", "", "http://localhost:3001"])("rejects origin %s", async (origin) => {
    await expect(readJson(request("{}", { origin }))).rejects.toMatchObject({ status: 403 });
  });
  it("rejects a missing origin and explicitly cross-site request", async () => {
    await expect(readJson(new Request("http://localhost:3000", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }))).rejects.toMatchObject({ status: 403 });
    await expect(readJson(request("{}", { "sec-fetch-site": "cross-site" }))).rejects.toMatchObject({ status: 403 });
  });
  it("rejects content types, malformed JSON and excessive streamed bodies", async () => {
    await expect(readJson(request("{}", { "content-type": "text/plain" }))).rejects.toMatchObject({ status: 415 });
    await expect(readJson(request("{"))).rejects.toMatchObject({ status: 400 });
    await expect(readJson(request("x".repeat(MAX_BODY_BYTES + 1)))).rejects.toMatchObject({ status: 413 });
    await expect(readJson(request("{}", { "content-length": String(MAX_BODY_BYTES + 1) }))).rejects.toMatchObject({ status: 413 });
  });
  it("never caches auth responses", () => {
    expect(authJson({ ok: true }).headers.get("cache-control")).toContain("no-store");
    const response = errorResponse(new AuthHttpError(429, "RATE_LIMITED", "Wait", undefined, 30));
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("redacts unexpected errors and logs only safe correlation information", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = errorResponse(new Error("password=supersecret&token=do-not-leak"));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("supersecret");
    expect(log.mock.calls.flat().join()).not.toContain("supersecret");
    log.mockRestore();
  });
});
