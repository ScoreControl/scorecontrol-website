import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";

// Actual PostgreSQL SQL/PLpgSQL, constraints and permissions; auth.users/roles are fixtures.
// This does not emulate GoTrue, PostgREST, or multi-connection production scheduling.
const db = new PGlite();
const migration = readFileSync(new URL("../../supabase/migrations/20261019000000_auth_usernames.sql", import.meta.url), "utf8");
const legacyId = randomUUID();
async function asRole<T>(role: "anon" | "authenticated" | "service_role" | "supabase_auth_admin", action: (tx: Transaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    return action(tx);
  });
}
async function signup(username?: unknown, provider = "email", id = randomUUID()) {
  const metadata = username === undefined ? {} : { scorecontrol_username: username };
  await asRole("supabase_auth_admin", (tx) => tx.query(
    "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)",
    [id, `${id}@example.com`, JSON.stringify(metadata), JSON.stringify({ provider })],
  ));
  return id;
}
/** An email account created before the migration's trigger existed, so it has no username. */
async function legacyAccount(id = randomUUID()) {
  await db.transaction(async (tx) => {
    await tx.exec("set local session_replication_role = replica");
    await tx.query("insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, '{}', $3)",
      [id, `${id}@example.com`, JSON.stringify({ provider: "email" })]);
  });
  return id;
}
async function claim(id: string, username: string) {
  const result = await asRole("service_role", (tx) => tx.query<{ username: string }>(
    "select public.auth_claim_username($1, $2) as username", [id, username],
  ));
  return result.rows[0].username;
}
async function username(id: string) {
  return (await asRole("service_role", (tx) => tx.query<{ username: string | null }>(
    "select public.auth_username_for_user($1) as username", [id],
  ))).rows[0].username;
}

beforeAll(async () => {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role supabase_auth_admin nologin;
    grant usage on schema public to anon, authenticated, service_role, supabase_auth_admin;
    -- Supabase projects may have broad defaults: the migration must revoke them.
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role, supabase_auth_admin;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
    grant usage on schema auth to supabase_auth_admin;
    grant select, insert, update, delete on auth.users to supabase_auth_admin;
  `);
  await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, 'legacy@example.com', $2)",
    [legacyId, JSON.stringify({ scorecontrol_username: "untrusted-old-metadata" })]);
  // Match Supabase's atomic per-migration transaction, including privilege changes.
  await db.transaction((tx) => tx.exec(migration));
}, 30_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.query("delete from auth.users where id <> $1", [legacyId]);
  await db.query("delete from scorecontrol_auth.usernames where user_id = $1", [legacyId]);
});

describe("auth-only username SQL migration", () => {
  it("keeps existing accounts intact without trusting/backfilling their metadata", async () => {
    expect(await username(legacyId)).toBeNull();
    expect((await db.query("select id from auth.users where id = $1", [legacyId])).rows).toHaveLength(1);
    expect(await claim(legacyId, "chosen-handle")).toBe("chosen-handle");
    // Restore the fixed legacy fixture for following tests.
    await db.query("delete from scorecontrol_auth.usernames where user_id = $1", [legacyId]);
  });
  it("registers a normalized handle inside signup, even under the restricted Auth service role", async () => {
    const id = await signup(" Octo-Cat ");
    expect(await username(id)).toBe("octo-cat");
  });
  it("rolls back the entire losing signup on a case-insensitive handle conflict", async () => {
    await signup("octocat");
    const loser = randomUUID();
    await expect(signup("OCTOCAT", "email", loser)).rejects.toMatchObject({ code: "23505" });
    expect((await db.query("select id from auth.users where id = $1", [loser])).rows).toEqual([]);
    expect((await db.query("select username from scorecontrol_auth.usernames")).rows).toEqual([{ username: "octocat" }]);
  });
  it.each(["admin", "-name", "name-", "name--name", "first_last", "álvaro", "x".repeat(40), "", null, 123, {}, true])(
    "rejects invalid/reserved direct provider metadata %j without creating an account", async (handle) => {
      const id = randomUUID();
      await expect(signup(handle, "email", id)).rejects.toMatchObject({ code: "22023" });
      expect((await db.query("select id from auth.users where id = $1", [id])).rows).toEqual([]);
    },
  );
  it("rejects new email accounts without a username, even through direct provider signup", async () => {
    const id = randomUUID();
    await expect(signup(undefined, "email", id)).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select id from auth.users where id = $1", [id])).rows).toEqual([]);
  });
  it("ignores social-provider username metadata", async () => {
    expect(await username(await signup("admin", "google"))).toBeNull();
    expect(await username(await signup({ arbitrary: true }, "google"))).toBeNull();
  });
  it("claims once, supports idempotent retries, and refuses another account taking the handle", async () => {
    const a = await legacyAccount();
    const b = await legacyAccount();
    expect(await claim(a, "New-Handle")).toBe("new-handle");
    expect(await claim(a, "new-handle")).toBe("new-handle");
    expect(await claim(a, "another-handle")).toBe("new-handle");
    await expect(claim(b, "NEW-HANDLE")).rejects.toMatchObject({ code: "23505" });
    expect(await username(b)).toBeNull();
    await expect(claim(randomUUID(), "orphan")).rejects.toMatchObject({ code: "23503" });
    await expect(claim(b, "settings")).rejects.toMatchObject({ code: "22023" });
  });
  it("arbitrates competing claims through the database UNIQUE constraint", async () => {
    const a = await legacyAccount();
    const b = await legacyAccount();
    const outcomes = await Promise.allSettled([claim(a, "one-winner"), claim(b, "one-winner")]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await db.query("select user_id from scorecontrol_auth.usernames where username = 'one-winner'")).rows).toHaveLength(1);
  });
  it("resolves the current email and never renames from editable metadata", async () => {
    const id = await signup("original-name");
    await asRole("supabase_auth_admin", (tx) => tx.query(
      "update auth.users set email = 'new-address@example.com', raw_user_meta_data = $2 where id = $1",
      [id, JSON.stringify({ scorecontrol_username: "attacker-edited-name" })],
    ));
    const result = await asRole("service_role", (tx) => tx.query(
      "select * from public.auth_resolve_username('ORIGINAL-NAME')",
    ));
    expect(result.rows).toEqual([{ user_id: id, email: "new-address@example.com" }]);
    expect(await username(id)).toBe("original-name");
    expect((await asRole("service_role", (tx) => tx.query("select * from public.auth_resolve_username('attacker-edited-name')"))).rows).toEqual([]);
  });
  it("cleans up a deleted account's handle", async () => {
    const id = await signup("removable");
    await asRole("supabase_auth_admin", (tx) => tx.query("delete from auth.users where id = $1", [id]));
    expect(await username(id)).toBeNull();
    expect(await claim(await legacyAccount(), "removable")).toBe("removable");
  });
  it("does not let a duplicate email consume a new handle", async () => {
    const id = await signup("kept-handle");
    await expect(db.query("insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values ($1, $2, $3, $4)",
      [randomUUID(), `${id}@example.com`, { provider: "email" }, { scorecontrol_username: "unclaimed" }])).rejects.toMatchObject({ code: "23505" });
    expect((await db.query("select username from scorecontrol_auth.usernames where username = 'unclaimed'")).rows).toEqual([]);
  });
  it.each(["anon", "authenticated", "supabase_auth_admin"] as const)("denies %s the lookup/claim interface and private table", async (role) => {
    const id = await signup("private-name");
    for (const [sql, params] of [
      ["select * from public.auth_resolve_username($1)", ["private-name"]],
      ["select public.auth_username_for_user($1)", [id]],
      ["select public.auth_claim_username($1, $2)", [id, "another-name"]],
      ["select * from scorecontrol_auth.usernames", []],
      ["select scorecontrol_auth.normalize_username('name')", []],
    ] as const) {
      await expect(asRole(role, (tx) => tx.query(sql, [...params]))).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("gives service_role only the intended RPC interface, with locked search paths", async () => {
    const id = await signup("server-only");
    expect(await username(id)).toBe("server-only");
    await expect(asRole("service_role", (tx) => tx.query("select * from scorecontrol_auth.usernames"))).rejects.toMatchObject({ code: "42501" });
    const functions = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] }>(`
      select p.proname, p.prosecdef, p.proconfig from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'public' and p.proname like 'auth_%')
         or (n.nspname = 'scorecontrol_auth' and p.proname = 'register_signup_username')
    `);
    expect(functions.rows).toHaveLength(4);
    for (const fn of functions.rows) {
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toContain('search_path=""');
    }
  });
  it("uses RLS as defense in depth if a future accidental grant exposes table reads", async () => {
    await signup("hidden-by-rls");
    const rollback = new Error("revert temporary test grants");
    await expect(db.transaction(async (tx) => {
      await tx.exec("grant usage on schema scorecontrol_auth to authenticated; grant select on scorecontrol_auth.usernames to authenticated; set local role authenticated");
      expect((await tx.query("select * from scorecontrol_auth.usernames")).rows).toEqual([]);
      throw rollback;
    })).rejects.toBe(rollback);
  });
  it("keeps table-level canonical/validation constraints even for privileged direct inserts", async () => {
    const id = await legacyAccount();
    await expect(db.query("insert into scorecontrol_auth.usernames values ($1, 'Uppercase')", [id])).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("insert into scorecontrol_auth.usernames values ($1, 'admin')", [id])).rejects.toMatchObject({ code: "22023" });
    expect(await username(id)).toBeNull();
  });
});
