import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Applies the real migrations in deployment order to embedded Postgres:
// Oliver's auth migration (supabase/migrations), then both Prisma migrations.
// auth.users and the Supabase roles are fixtures.
const db = new PGlite();
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const MB25 = 26_214_400;

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const sha = () => randomUUID().replace(/-/g, "").repeat(2);

async function signup(username: string, id = randomUUID()) {
  await db.transaction(async (tx) => {
    await tx.exec("set local role supabase_auth_admin");
    await tx.query("insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)",
      [id, `${id}@example.com`, JSON.stringify({ scorecontrol_username: username }), JSON.stringify({ provider: "email" })]);
  });
  return id;
}

/** A project with a default `main` branch, created the way the app will: one transaction. */
async function project(ownerId: string) {
  const id = randomUUID();
  const main = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query("insert into projects (id, owner_id, slug, name) values ($1, $2, $3, 'Quartet')", [id, ownerId, `quartet-${id.slice(0, 8)}`]);
    await tx.query("insert into branches (id, project_id, name) values ($1, $2, 'main')", [main, id]);
    await tx.query("update projects set default_branch_id = $1 where id = $2", [main, id]);
  });
  return { id, main };
}

async function blob(projectId: string, size = 1000) {
  const hash = sha();
  const [row] = await q<{ id: string }>(
    "insert into blobs (project_id, sha256, size_bytes, content_type, storage_path) values ($1, $2, $3, 'application/vnd.recordare.musicxml+xml', $4) returning id",
    [projectId, hash, size, `${projectId}/${hash}`]);
  return row.id;
}

async function commit(projectId: string, authorId: string | null, message: string, files: Record<string, string>, parents: string[] = []) {
  const [row] = await q<{ id: string }>("insert into commits (project_id, author_id, message) values ($1, $2, $3) returning id", [projectId, authorId, message]);
  for (const [path, blobId] of Object.entries(files)) {
    await q("insert into commit_files (commit_id, path, blob_id) values ($1, $2, $3)", [row.id, path, blobId]);
  }
  for (const [position, parentId] of parents.entries()) {
    await q("insert into commit_parents (commit_id, parent_id, position) values ($1, $2, $3)", [row.id, parentId, position]);
  }
  return row.id;
}

/** Compare-and-swap: moves the branch only if its head is still `expected`. */
async function advance(branchId: string, expected: string | null, next: string) {
  const result = await db.query("update branches set head_commit_id = $1 where id = $2 and head_commit_id is not distinct from $3", [next, branchId, expected]);
  return result.affectedRows === 1;
}

beforeAll(async () => {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role supabase_auth_admin nologin;
    grant usage on schema public to anon, authenticated, service_role, supabase_auth_admin;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
    grant usage on schema auth to supabase_auth_admin;
    grant select, insert, update, delete on auth.users to supabase_auth_admin;
  `);
  await db.transaction((tx) => tx.exec(read("supabase/migrations/20261019000000_auth_usernames.sql")));
  await db.exec(read("prisma/migrations/20261027000000_init_schema/migration.sql"));
  await db.exec(read("prisma/migrations/20261027000100_users_sync_triggers/migration.sql"));
}, 60_000);
afterAll(async () => { await db.close(); });

describe("init_schema migration", () => {
  it("enables RLS on every public table", async () => {
    expect(await q("select tablename from pg_tables where schemaname = 'public' and not rowsecurity")).toEqual([]);
  });

  it("limits files to 1 byte through 25 MB and defaults the format to MusicXML", async () => {
    const { id } = await project(await signup(`size-${randomUUID().slice(0, 8)}`));
    const blobId = await blob(id, MB25);
    expect((await q<{ format: string }>("select format from blobs where id = $1", [blobId]))[0].format).toBe("MUSICXML");
    await expect(blob(id, MB25 + 1)).rejects.toThrow(/blobs_size_bytes_check/);
    await expect(blob(id, 0)).rejects.toThrow(/blobs_size_bytes_check/);
  });

  it("requires a commit message and stores AI output", async () => {
    const owner = await signup(`ai-${randomUUID().slice(0, 8)}`);
    const { id } = await project(owner);
    await expect(q("insert into commits (project_id, author_id) values ($1, $2)", [id, owner])).rejects.toThrow(/message/);
    await q("insert into commits (project_id, author_id, message, ai_summary) values ($1, $2, 'Fix bowing', 'Changed bowing in m. 12')", [id, owner]);
    await q("insert into pull_requests (project_id, number, title, ai_conflict_notes) values ($1, 1, 'Viola part', $2)",
      [id, JSON.stringify({ measure_12_alto: "Option A keeps parallel motion" })]);
    const [note] = await q<{ note: string }>("select ai_conflict_notes->>'measure_12_alto' as note from pull_requests where project_id = $1", [id]);
    expect(note.note).toBe("Option A keeps parallel motion");
  });

  it("hides archived branches from the active list using the partial index", async () => {
    const { id } = await project(await signup(`arch-${randomUUID().slice(0, 8)}`));
    await q("insert into branches (project_id, name, archived_at) values ($1, 'old-idea', now())", [id]);
    const active = await q<{ name: string }>("select name from branches where project_id = $1 and archived_at is null", [id]);
    expect(active.map((row) => row.name)).toEqual(["main"]);
    const [index] = await q<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'idx_branches_project_active'");
    expect(index.indexdef).toMatch(/WHERE \(archived_at IS NULL\)/);
  });
});

describe("version history", () => {
  it("branches, merges, and walks first-parent history", async () => {
    const composer = await signup(`comp-${randomUUID().slice(0, 8)}`);
    const { id, main } = await project(composer);
    const [b1, b2, b3, b4] = [await blob(id), await blob(id), await blob(id), await blob(id)];

    const c1 = await commit(id, composer, "Initial score", { "score.musicxml": b1 });
    expect(await advance(main, null, c1)).toBe(true);
    const c2 = await commit(id, composer, "Fix bowing", { "score.musicxml": b2 }, [c1]);
    expect(await advance(main, c1, c2)).toBe(true);

    const [{ id: feature }] = await q<{ id: string }>("insert into branches (project_id, name, head_commit_id) values ($1, 'viola-edits', $2) returning id", [id, c2]);
    const c3 = await commit(id, composer, "Add viola part", { "score.musicxml": b2, "parts/viola.musicxml": b3 }, [c2]);
    expect(await advance(feature, c2, c3)).toBe(true);
    const c4 = await commit(id, composer, "Title page", { "score.musicxml": b4 }, [c2]);
    expect(await advance(main, c2, c4)).toBe(true);

    const c5 = await commit(id, composer, "Merge viola-edits", { "score.musicxml": b4, "parts/viola.musicxml": b3 }, [c4, c3]);
    expect(await advance(main, c2, c5)).toBe(false); // stale expected head is rejected
    expect(await advance(main, c4, c5)).toBe(true);

    const history = await q<{ message: string }>(`
      with recursive h(id, depth) as (
        select head_commit_id, 0 from branches where id = $1
        union all
        select p.parent_id, h.depth + 1 from h join commit_parents p on p.commit_id = h.id and p.position = 0
      ) select c.message from h join commits c on c.id = h.id order by h.depth`, [main]);
    expect(history.map((row) => row.message)).toEqual(["Merge viola-edits", "Title page", "Fix bowing", "Initial score"]);

    const changed = await q<{ path: string }>(`
      select coalesce(n.path, o.path) as path
      from (select * from commit_files where commit_id = $1) n
      full join (select * from commit_files where commit_id = $2) o on o.path = n.path
      where n.blob_id is distinct from o.blob_id`, [c5, c4]);
    expect(changed.map((row) => row.path)).toEqual(["parts/viola.musicxml"]);
  });

  it("rejects duplicate paths in a commit and duplicate content in a project", async () => {
    const owner = await signup(`dup-${randomUUID().slice(0, 8)}`);
    const { id } = await project(owner);
    const b = await blob(id);
    const c = await commit(id, owner, "One", { "score.musicxml": b });
    await expect(q("insert into commit_files (commit_id, path, blob_id) values ($1, 'score.musicxml', $2)", [c, b])).rejects.toThrow(/commit_files_pkey/);
    const [{ sha256 }] = await q<{ sha256: string }>("select sha256 from blobs where id = $1", [b]);
    await expect(q("insert into blobs (project_id, sha256, size_bytes, content_type, storage_path) values ($1, $2, 1, 'x', 'x')", [id, sha256]))
      .rejects.toThrow(/blobs_project_id_sha256_key/);
  });
});

describe("users and deletion", () => {
  it("creates a users row with the normalized username at signup", async () => {
    const id = await signup(" Octo-Cat ");
    expect(await q("select username from users where id = $1", [id])).toEqual([{ username: "octo-cat" }]);
  });

  it("creates the users row when an account without a username claims one", async () => {
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.exec("set local role supabase_auth_admin");
      await tx.query("insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, '{}', $3)",
        [id, `${id}@example.com`, JSON.stringify({ provider: "google" })]);
    });
    expect(await q("select id from users where id = $1", [id])).toEqual([]);
    await db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      await tx.query("select public.auth_claim_username($1, 'late-claimer')", [id]);
    });
    expect(await q("select username from users where id = $1", [id])).toEqual([{ username: "late-claimer" }]);
  });

  it("deleting an account deletes its projects but keeps its commits in other projects", async () => {
    const owner = await signup(`own-${randomUUID().slice(0, 8)}`);
    const collaborator = await signup(`col-${randomUUID().slice(0, 8)}`);
    const owned = await project(collaborator);
    const shared = await project(owner);
    const c = await commit(shared.id, collaborator, "Viola edits", { "score.musicxml": await blob(shared.id) });

    await db.transaction(async (tx) => {
      await tx.exec("set local role supabase_auth_admin");
      await tx.query("delete from auth.users where id = $1", [collaborator]);
    });
    expect(await q("select id from users where id = $1", [collaborator])).toEqual([]);
    expect(await q("select id from projects where id = $1", [owned.id])).toEqual([]);
    expect(await q("select author_id from commits where id = $1", [c])).toEqual([{ author_id: null }]);
  });

  it("blocks deleting a project's default branch, and deleting a project removes its history", async () => {
    const owner = await signup(`del-${randomUUID().slice(0, 8)}`);
    const { id, main } = await project(owner);
    const c = await commit(id, owner, "Initial", { "score.musicxml": await blob(id) });
    await advance(main, null, c);
    await expect(q("delete from branches where id = $1", [main])).rejects.toThrow(/projects_default_branch_id_fkey/);
    await q("delete from projects where id = $1", [id]);
    for (const table of ["branches", "commits", "blobs"]) {
      expect(await q(`select 1 from ${table} where project_id = $1`, [id])).toEqual([]);
    }
  });
});
