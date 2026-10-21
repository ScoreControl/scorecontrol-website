import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

// Runs on the LOOPBACK project validated by playwright.config.ts, with the username migration applied.
// These tests create disposable local accounts.
const password = "Local-test-only-password-123!";
const handle = () => `u-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
async function call(page: Page, path: string, body?: unknown) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, body === undefined ? undefined : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }, { path, body });
}

test("real mapping supports username signup and login by username or email", async ({ page }) => {
  await page.goto("/");
  const email = `${randomUUID()}@example.com`;
  const username = handle();
  const signup = await call(page, "/api/auth/signup", { email, username: username.toUpperCase(), password });
  expect(signup.status).toBe(201);
  expect(signup.body.data.user.username).toBe(username);
  const id = signup.body.data.user.id;
  const duplicate = await call(page, "/api/auth/signup", { email: `${randomUUID()}@example.com`, username, password });
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.error.code).toBe("USERNAME_TAKEN");
  await call(page, "/api/auth/logout", {});
  const login = await call(page, "/api/auth/login", { identifier: username.toUpperCase(), password });
  expect(login.status).toBe(200);
  expect(login.body.data.user.id).toBe(id);
  expect((await call(page, "/api/auth/me")).body.data.user.username).toBe(username);
  await call(page, "/api/auth/logout", {});
  const byEmail = await call(page, "/api/auth/login", { identifier: email, password });
  expect(byEmail.body.data.user.username).toBe(username);
});

test("every new account needs a username, including direct signups that bypass the app", async ({ page }) => {
  await page.goto("/");
  const viaApp = await call(page, "/api/auth/signup", { email: `${randomUUID()}@example.com`, password });
  expect(viaApp.status).toBe(400);
  expect(viaApp.body.error.fields.username).toBeDefined();
  // The publishable key is public, so anyone can call Supabase's signup API directly.
  const url = process.env.AUTH_TEST_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const direct = createClient(url, process.env.AUTH_TEST_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const email = `${randomUUID()}@example.com`;
  const { data, error } = await direct.auth.signUp({ email, password });
  expect(error).not.toBeNull();
  expect(data.session).toBeNull();
  expect((await direct.auth.signInWithPassword({ email, password })).error?.code).toBe("invalid_credentials");
});

test("actual provider rejects a competing signup atomically and denies browser RPC access", async () => {
  const url = process.env.AUTH_TEST_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const key = process.env.AUTH_TEST_SUPABASE_PUBLISHABLE_KEY!;
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const a = createClient(url, key, options);
  const b = createClient(url, key, options);
  const emailA = `${randomUUID()}@example.com`;
  const emailB = `${randomUUID()}@example.com`;
  const username = handle();
  const outcomes = await Promise.all([
    a.auth.signUp({ email: emailA, password, options: { data: { scorecontrol_username: username } } }),
    b.auth.signUp({ email: emailB, password, options: { data: { scorecontrol_username: username.toUpperCase() } } }),
  ]);
  expect(outcomes.filter((result) => result.data.session && !result.error)).toHaveLength(1);
  expect(outcomes.filter((result) => result.error)).toHaveLength(1);
  const winner = outcomes[0].error ? b : a;
  const loserEmail = outcomes[0].error ? emailA : emailB;
  const publicClient = createClient(url, key, options);
  const loserLogin = await publicClient.auth.signInWithPassword({ email: loserEmail, password });
  expect(loserLogin.data.session).toBeNull(); // No orphaned account with a working password.
  expect(loserLogin.error?.code).toBe("invalid_credentials");
  for (const client of [publicClient, winner]) {
    expect((await client.rpc("auth_resolve_username", { requested_username: username })).error).not.toBeNull();
    expect((await client.rpc("auth_claim_username", { account_id: randomUUID(), requested_username: handle() })).error).not.toBeNull();
  }
  const admin = createClient(url, process.env.AUTH_TEST_SUPABASE_SECRET_KEY!, options);
  const resolved = await admin.rpc("auth_resolve_username", { requested_username: username });
  expect(resolved.error).toBeNull();
  expect(resolved.data).toHaveLength(1);
  expect(resolved.data[0].user_id).toBe(outcomes.find((result) => result.data.session)?.data.user?.id);
});
