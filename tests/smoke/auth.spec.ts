import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const password = "Test-only-password-123!";
async function call(page: Page, path: string, body?: unknown) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, body === undefined ? undefined : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }, { path, body });
}
async function signup(page: Page) {
  const email = `smoke-${randomUUID()}@example.com`;
  const username = `u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const response = await call(page, "/api/auth/signup", { email, password, username });
  expect(response.status).toBe(201);
  expect(response.body.data.user.username).toBe(username);
  return { email, username, id: response.body.data.user.id };
}

test("browser login uses HttpOnly remembered cookies, survives reload and signs out", async ({ page, context }) => {
  await page.goto("/");
  const account = await signup(page);
  expect((await call(page, "/api/auth/logout", {})).status).toBe(204);
  const login = await call(page, "/api/auth/login", { identifier: account.username.toUpperCase(), password, rememberMe: true });
  expect(login.status).toBe(200);
  expect(login.body.data.user.id).toBe(account.id);
  expect(JSON.stringify(login.body)).not.toContain("access_token");
  const cookies = await context.cookies();
  const token = cookies.find((cookie) => cookie.name === "sc-auth");
  expect(token?.httpOnly).toBe(true);
  expect(token?.sameSite).toBe("Lax");
  expect(token!.expires).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
  expect(await page.evaluate(() => document.cookie)).not.toContain("sc-auth");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.reload();
  expect((await call(page, "/api/auth/me")).body.data.user.id).toBe(account.id);
  expect((await call(page, "/api/auth/logout", {})).status).toBe(204);
  expect((await call(page, "/api/auth/me")).status).toBe(401);
  expect((await context.cookies()).filter((cookie) => cookie.name.startsWith("sc-auth"))).toEqual([]);
});

test("expired access token refreshes through HTTP while unchecked cookies remain session-only", async ({ page, context }) => {
  await page.goto("/");
  const account = await signup(page);
  await call(page, "/api/auth/login", { email: account.email, password, rememberMe: false });
  const cookies = await context.cookies();
  const token = cookies.find((cookie) => cookie.name === "sc-auth")!;
  expect(token.expires).toBe(-1);
  const session = JSON.parse(Buffer.from(token.value.replace(/^base64-/, ""), "base64url").toString());
  session.expires_at = Math.floor(Date.now() / 1000) - 60;
  await context.addCookies([{ ...token, value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}` }]);
  expect((await call(page, "/api/auth/me")).body.data.user.id).toBe(account.id);
  const refreshed = (await context.cookies()).find((cookie) => cookie.name === "sc-auth")!;
  expect(refreshed.value).not.toBe(token.value);
  expect(refreshed.expires).toBe(-1);
});

test("local logout leaves a separate device signed in", async ({ browser, page }) => {
  await page.goto("/");
  const account = await signup(page);
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await otherPage.goto("http://localhost:3100/");
    expect((await call(otherPage, "/api/auth/login", { identifier: account.email, password })).status).toBe(200);
    expect((await call(page, "/api/auth/logout", {})).status).toBe(204);
    expect((await call(otherPage, "/api/auth/me")).body.data.user.id).toBe(account.id);
  } finally { await other.close(); }
});

test("running routes enforce origin, input and generic unknown-username behavior", async ({ page, request }) => {
  await page.goto("/");
  const disallowed = await request.post("/api/auth/login", { data: { identifier: "test@example.com", password }, headers: { Origin: "https://evil.example" } });
  expect(disallowed.status()).toBe(403);
  expect((await disallowed.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
  const username = await call(page, "/api/auth/login", { identifier: "future-username", password });
  expect(username.status).toBe(401);
  expect(username.body.error.code).toBe("INVALID_CREDENTIALS");
  expect((await call(page, "/api/auth/login", { identifier: "test@example.com", password, rememberMe: "true" })).status).toBe(400);
  const noUsername = await call(page, "/api/auth/signup", { email: `smoke-${randomUUID()}@example.com`, password });
  expect(noUsername.body.error.fields.username).toBeDefined();
  const callback = await request.get("/auth/confirm?code=x&code=y&next=https://evil.example", { maxRedirects: 0 });
  expect(callback.status()).toBe(303);
  expect(callback.headers().location).toBe("http://localhost:3100/login?error=confirmation_failed");
});

test("an account created before usernames were required can claim one and use it at login", async ({ page, request }) => {
  // Created directly at the simulated provider, as pre-existing accounts were; app signup now requires a username.
  const email = `smoke-${randomUUID()}@example.com`;
  const created = await (await request.post("http://127.0.0.1:54329/auth/v1/signup", { data: { email, password } })).json();
  const account = { id: created.user.id, username: `u-${randomUUID().replaceAll("-", "").slice(0, 24)}` };
  await page.goto("/");
  const signedIn = await call(page, "/api/auth/login", { identifier: email, password });
  expect(signedIn.body.data.user.username).toBeNull();
  const claimed = await call(page, "/api/auth/username", { username: account.username });
  expect(claimed.status).toBe(200);
  expect(claimed.body.data.user.id).toBe(account.id);
  expect(claimed.body.data.user.username).toBe(account.username);
  expect((await call(page, "/api/auth/logout", {})).status).toBe(204);
  const login = await call(page, "/api/auth/login", { identifier: account.username, password });
  expect(login.status).toBe(200);
  expect(login.body.data.user.id).toBe(account.id);
});

test("password reset link and signed-in password change revoke other sessions", async ({ browser, page, request }) => {
  // Create the account at the simulated provider: the app's own signup quota is spent by earlier tests.
  const email = `smoke-${randomUUID()}@example.com`;
  const created = await (await request.post("http://127.0.0.1:54329/auth/v1/signup", { data: { email, password } })).json();
  const account = { email, id: created.user.id };
  await page.goto("/");
  expect((await call(page, "/api/auth/login", { identifier: account.email, password })).status).toBe(200);
  const other = await browser.newContext();
  try {
    const device = await other.newPage();
    await device.goto("/");
    expect((await call(device, "/api/auth/login", { identifier: account.email, password })).status).toBe(200);

    expect((await call(page, "/api/auth/forgot-password", { email: account.email })).status).toBe(202);
    const tokenHash = await (await request.get(`http://127.0.0.1:54329/test/recovery?email=${encodeURIComponent(account.email)}`)).json();

    const resetPassword = "Reset-only-password-456!";
    const reset = await call(page, "/api/auth/reset-password", { tokenHash, password: resetPassword });
    expect(reset.body).toEqual({ data: { status: "password_updated", otherSessionsRevoked: true } });
    expect((await call(page, "/api/auth/reset-password", { tokenHash, password: resetPassword })).body.error.code).toBe("RECOVERY_LINK_INVALID");
    expect((await call(page, "/api/auth/me")).body.data.user.id).toBe(account.id);
    expect((await call(device, "/api/auth/me")).status).toBe(401);
    expect((await call(device, "/api/auth/login", { identifier: account.email, password })).body.error.code).toBe("INVALID_CREDENTIALS");

    expect((await call(device, "/api/auth/login", { identifier: account.email, password: resetPassword })).status).toBe(200);
    const changedPassword = "Changed-only-password-789!";
    expect((await call(device, "/api/auth/password", { password: changedPassword })).body.error.code).toBe("CURRENT_PASSWORD_REQUIRED");
    expect((await call(device, "/api/auth/password", { password: changedPassword, currentPassword: "wrong" })).body.error.code)
      .toBe("INVALID_CURRENT_PASSWORD");
    expect((await call(device, "/api/auth/password", { password: changedPassword, currentPassword: resetPassword })).status).toBe(200);
    expect((await call(device, "/api/auth/me")).body.data.user.id).toBe(account.id);
    expect((await call(page, "/api/auth/me")).status).toBe(401);
  } finally { await other.close(); }
});
