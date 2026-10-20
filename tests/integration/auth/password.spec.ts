import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

// Real local Supabase. The local config allows 2 auth emails per hour, and the first test sends one.
const supabaseUrl = process.env.AUTH_TEST_SUPABASE_URL ?? "http://127.0.0.1:54321";
const mailpitUrl = process.env.AUTH_TEST_MAILPIT_URL ?? "http://127.0.0.1:54324";
const secretKey = process.env.AUTH_TEST_SUPABASE_SECRET_KEY;
const password = "Local-test-only-password-123!";
const newPassword = "Local-test-only-password-456!";

async function call(page: Page, path: string, body?: unknown) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, body === undefined ? undefined : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }, { path, body });
}

/**
 * Create the account directly at Supabase and sign in through the app. App signups share the
 * dev server's 5-per-hour signup quota with the other integration specs.
 */
async function signup(page: Page) {
  const email = `password-${randomUUID()}@example.com`;
  const provider = createClient(supabaseUrl, process.env.AUTH_TEST_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const username = `p-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const { data, error } = await provider.auth.signUp({ email, password, options: { data: { scorecontrol_username: username } } });
  expect(error).toBeNull();
  expect(data.session, "This suite expects local auth.email.enable_confirmations=false").not.toBeNull();
  expect((await call(page, "/api/auth/login", { identifier: email, password })).status).toBe(200);
  return { email, id: data.user!.id };
}

/** Wait for the recovery email in local Mailpit and return its Supabase verify link. */
async function recoveryLink(email: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const search = await (await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    const id = search.messages?.[0]?.ID;
    if (id) {
      const message = await (await fetch(`${mailpitUrl}/api/v1/message/${id}`)).json();
      const link = `${message.Text ?? ""} ${message.HTML ?? ""}`.match(/https?:\/\/[^\s"'<>)]+\/auth\/v1\/verify[^\s"'<>)]+/)?.[0];
      if (link) return link.replaceAll("&amp;", "&");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No recovery email for ${email} in Mailpit at ${mailpitUrl}`);
}

test("default-template reset email signs in the requesting browser and sets a password without the old one", async ({ page, browser }) => {
  await page.goto("/");
  const account = await signup(page);
  const other = await browser.newContext();
  try {
    const device = await other.newPage();
    await device.goto("/");
    expect((await call(device, "/api/auth/login", { identifier: account.email, password })).status).toBe(200);
    await call(page, "/api/auth/logout", {});

    expect((await call(page, "/api/auth/forgot-password", { email: account.email })).status).toBe(202);
    await page.goto(await recoveryLink(account.email));
    expect(new URL(page.url()).pathname).toBe("/reset-password");
    expect((await call(page, "/api/auth/me")).body.data.user.id).toBe(account.id);

    // Real recovery sessions must be recognised as recent email proof (AMR) by the change endpoint.
    const change = await call(page, "/api/auth/password", { password: newPassword });
    expect(change.body).toEqual({ data: { status: "password_updated", otherSessionsRevoked: true } });
    expect((await call(device, "/api/auth/me")).status).toBe(401);
    expect((await call(device, "/api/auth/login", { identifier: account.email, password })).body.error.code).toBe("INVALID_CREDENTIALS");
    expect((await call(device, "/api/auth/login", { identifier: account.email, password: newPassword })).status).toBe(200);
  } finally { await other.close(); }
});

test.describe("token-hash links", () => {
  const admin = () => createClient(supabaseUrl, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });

  test("reset link works on any device, is single-use, and change-password then needs the current password", async ({ page, browser }) => {
    await page.goto("/");
    const account = await signup(page);
    await call(page, "/api/auth/logout", {});
    const { data, error } = await admin().auth.admin.generateLink({ type: "recovery", email: account.email });
    expect(error).toBeNull();
    const tokenHash = data.properties!.hashed_token;

    // The reset email links to /reset-password#token_hash=...; the page posts the fragment's token.
    const reset = await call(page, "/api/auth/reset-password", { tokenHash, password: newPassword });
    expect(reset.status).toBe(200);
    expect((await call(page, "/api/auth/me")).body.data.user.id).toBe(account.id);
    expect((await call(page, "/api/auth/reset-password", { tokenHash, password: newPassword })).body.error.code).toBe("RECOVERY_LINK_INVALID");

    const other = await browser.newContext();
    try {
      const device = await other.newPage();
      await device.goto("/");
      expect((await call(device, "/api/auth/login", { identifier: account.email, password: newPassword })).status).toBe(200);
      const changed = "Local-test-only-password-789!";
      expect((await call(device, "/api/auth/password", { password: changed })).body.error.code).toBe("CURRENT_PASSWORD_REQUIRED");
      expect((await call(device, "/api/auth/password", { password: changed, currentPassword: "wrong" })).body.error.code)
        .toBe("INVALID_CURRENT_PASSWORD");
      expect((await call(device, "/api/auth/password", { password: changed, currentPassword: newPassword })).status).toBe(200);
      expect((await call(page, "/api/auth/me")).status).toBe(401);
      expect((await call(device, "/api/auth/me")).body.data.user.id).toBe(account.id);
    } finally { await other.close(); }
  });

  test("signup confirmation link confirms without signing the browser in", async ({ request }) => {
    const email = `confirm-${randomUUID()}@example.com`;
    const username = `c-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const { data, error } = await admin().auth.admin.generateLink({ type: "signup", email, password, options: { data: { scorecontrol_username: username } } });
    expect(error).toBeNull();
    const response = await request.get(`/auth/confirm?token_hash=${data.properties!.hashed_token}&type=email`, { maxRedirects: 0 });
    expect(response.headers().location).toBe("http://localhost:3000/login?status=email_confirmed");
    expect(response.headers()["set-cookie"] ?? "").not.toContain("sc-auth=");
  });
});
