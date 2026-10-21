import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Uses actual local Supabase. Default committed Supabase config has confirmations disabled.
// For confirmation-enabled testing, run the manual email-flow procedure in AUTH_API.md as well.
test("real local Supabase account, session, login, refresh, and local logout", async ({ page, context, browser }) => {
  await page.goto("/");
  const email = `auth-integration-${randomUUID()}@example.com`;
  const password = "Local-test-only-password-123!";
  const username = `s-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const signup = await page.evaluate(async ({ email, password, username }) => {
    const response = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, username }) });
    return { status: response.status, body: await response.json() };
  }, { email, password, username });
  expect(signup.status, "This suite expects local auth.email.enable_confirmations=false").toBe(201);
  const id = signup.body.data.user.id;
  const other = await browser.newContext();
  try {
    const device = await other.newPage();
    await device.goto("http://localhost:3000/");
    expect(await device.evaluate(async ({ email, password }) => (await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: email, password, rememberMe: true }),
    })).status, { email, password })).toBe(200);
    // Real provider sessions can exceed the SDK's chunk threshold; read/write all chunks.
    const tokens = (await context.cookies()).filter((cookie) => /^sc-auth(?:\.\d+)?$/.test(cookie.name))
      .sort((a, b) => Number(a.name.split(".")[1] ?? 0) - Number(b.name.split(".")[1] ?? 0));
    expect(tokens.length).toBeGreaterThan(0);
    const encoded = tokens.map((cookie) => cookie.value).join("");
    const stored = JSON.parse(Buffer.from(encoded.replace(/^base64-/, ""), "base64url").toString());
    stored.expires_at = Math.floor(Date.now() / 1000) - 60;
    const expired = `base64-${Buffer.from(JSON.stringify(stored)).toString("base64url")}`;
    await context.clearCookies({ name: /^sc-auth(?:\.\d+)?$/ });
    await context.addCookies(Array.from({ length: Math.ceil(expired.length / 3000) }, (_, index) => ({
      ...tokens[0], name: `sc-auth.${index}`, value: expired.slice(index * 3000, (index + 1) * 3000),
    })));
    const me = await page.evaluate(async () => (await fetch("/api/auth/me")).json());
    expect(me.data.user.id).toBe(id);
    expect(await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status)).toBe(204);
    expect(await page.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(401);
    expect((await device.evaluate(async () => (await fetch("/api/auth/me")).json())).data.user.id).toBe(id);
  } finally { await other.close(); }
});
