import { describe, expect, it } from "vitest";
import { NextResponse } from "next/server";
import { AUTH_COOKIE, PERSISTENCE_COOKIE, REMEMBER_SECONDS, createCookieBridge, sessionCookieOptions } from "@/lib/auth/cookies";

describe("session cookie policies", () => {
  it("strips persistent expiry and domains for an unchecked login", () => {
    const options = sessionCookieOptions({ maxAge: 9999, expires: new Date(Date.now() + 999999), domain: ".example.com" }, false, true);
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(options.maxAge).toBeUndefined();
    expect(options.expires).toBeUndefined();
    expect(options.domain).toBeUndefined();
  });
  it("uses thirty days for remembered sessions", () => {
    expect(sessionCookieOptions({}, true, false).maxAge).toBe(REMEMBER_SECONDS);
  });
  it("does not resurrect deleted cookies", () => {
    expect(sessionCookieOptions({ maxAge: 0 }, true, true).maxAge).toBe(0);
    expect(sessionCookieOptions({ expires: new Date(0) }, true, true).expires).toEqual(new Date(0));
  });
  it.each([false, true])("preserves remembered=%s through refresh and SDK chunk replacement", (remember) => {
    const bridge = createCookieBridge([{ name: `${AUTH_COOKIE}.0`, value: "old0" }, { name: `${AUTH_COOKIE}.1`, value: "old1" },
      { name: PERSISTENCE_COOKIE, value: remember ? "remember" : "session" }], true);
    bridge.setAll([
      { name: `${AUTH_COOKIE}.0`, value: "", options: { maxAge: 0 } },
      { name: `${AUTH_COOKIE}.1`, value: "", options: { maxAge: 0 } },
      { name: AUTH_COOKIE, value: "new-token", options: { maxAge: 4000000 } },
    ], { "Cache-Control": "private, no-store", Pragma: "no-cache" });
    const response = bridge.apply(new NextResponse());
    expect(response.cookies.get(AUTH_COOKIE)).toMatchObject({ value: "new-token", httpOnly: true, secure: true });
    expect(response.cookies.get(AUTH_COOKIE)?.maxAge).toBe(remember ? REMEMBER_SECONDS : undefined);
    expect(response.cookies.get(`${AUTH_COOKIE}.0`)?.maxAge).toBe(0);
    expect(response.cookies.get(PERSISTENCE_COOKIE)?.value).toBe(remember ? "remember" : "session");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(bridge.getAll().some(({ name }) => name === `${AUTH_COOKIE}.1`)).toBe(false);
  });
  it("leaves SDK verifier expiry intact", () => {
    const bridge = createCookieBridge([], true);
    bridge.setAll([{ name: `${AUTH_COOKIE}-code-verifier`, value: "verifier", options: { maxAge: 60 } }]);
    const response = bridge.apply(new NextResponse());
    expect(response.cookies.get(`${AUTH_COOKIE}-code-verifier`)).toMatchObject({ maxAge: 60, httpOnly: true });
    expect(response.cookies.has(PERSISTENCE_COOKIE)).toBe(false);
  });
  it("clears every auth chunk, preference and verifier without deleting unrelated cookies", () => {
    const bridge = createCookieBridge([{ name: `${AUTH_COOKIE}.0`, value: "a" }, { name: `${AUTH_COOKIE}.1`, value: "b" },
      { name: "theme", value: "dark" }, { name: `${AUTH_COOKIE}-code-verifier`, value: "v" }], true);
    bridge.clear(true);
    const response = bridge.apply(new NextResponse());
    for (const name of [AUTH_COOKIE, `${AUTH_COOKIE}.0`, `${AUTH_COOKIE}.1`, PERSISTENCE_COOKIE, `${AUTH_COOKIE}-code-verifier`]) {
      expect(response.cookies.get(name)?.maxAge).toBe(0);
    }
    expect(bridge.getAll()).toEqual([{ name: "theme", value: "dark" }]);
  });
  it("can roll back partial provider writes during an outage", () => {
    const bridge = createCookieBridge([{ name: AUTH_COOKIE, value: "original" }], false);
    bridge.setAll([{ name: AUTH_COOKIE, value: "", options: { maxAge: 0 } }]);
    bridge.rollback();
    expect(bridge.getAll()).toEqual([{ name: AUTH_COOKIE, value: "original" }]);
    expect(bridge.apply(new NextResponse()).cookies.getAll()).toEqual([]);
  });
  it("isolates separate request cookie stores", () => {
    const a = createCookieBridge([{ name: AUTH_COOKIE, value: "user-a" }], false);
    const b = createCookieBridge([{ name: AUTH_COOKIE, value: "user-b" }], false);
    a.clear();
    expect(b.getAll()).toEqual([{ name: AUTH_COOKIE, value: "user-b" }]);
  });
});
