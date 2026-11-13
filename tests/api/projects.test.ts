import { readdirSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";

// Section 5 of docs/api-contract.md against embedded Postgres with every Prisma migration applied,
// through the app's Prisma adapter. PGlite is served on a local socket so node-postgres can connect.
vi.mock("@/lib/db", () => ({ getDb: () => { throw new Error("tests pass a db explicitly"); } }));
import * as projects from "@/lib/projects/service";
import { AuthHttpError } from "@/lib/auth/errors";
import { createProjectResponseSchema, getProjectResponseSchema, listProjectsResponseSchema, syncQuerySchema, syncResponseSchema, historyQuerySchema, historyResponseSchema, commitDetailResponseSchema } from "@/lib/api/contract";

const pg = new PGlite();
const server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1" });
let db: PrismaClient;
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

async function user(username: string) {
  const id = randomUUID();
  await pg.query("insert into users (id, username) values ($1, $2)", [id, username]);
  return id;
}
async function member(projectId: string, userId: string, role: "ADMIN" | "EDITOR" | "VIEWER") {
  await pg.query("insert into project_members (project_id, user_id, role) values ($1, $2, $3)", [projectId, userId, role]);
}
/** A commit on the project's main branch, moving its head. Returns the full hash. */
async function commitOnMain(projectId: string, message: string, hash = createHash("sha256").update(randomUUID()).digest("hex")) {
  const [{ id }] = (await pg.query<{ id: string }>("insert into commits (project_id, message, hash) values ($1, $2, $3) returning id", [projectId, message, hash])).rows;
  await pg.query("update branches set head_commit_id = $1 where project_id = $2 and name = 'main'", [id, projectId]);
  return hash;
}
/** "<status> <code>" of the error a call throws. */
async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (error) {
    if (error instanceof AuthHttpError) return `${error.status} ${error.code}`;
    throw error;
  }
  throw new Error("Expected the call to fail.");
}
const create = (userId: string, name: string, description?: string) =>
  projects.createProject(userId, { name, format: "MUSICXML", ...(description ? { description } : {}) }, db);

let owner: string, admin: string, editor: string, viewer: string, outsider: string;

beforeAll(async () => {
  await pg.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  for (const dir of readdirSync(new URL("../../prisma/migrations", import.meta.url)).filter((d) => /^\d/.test(d)).sort()) {
    await pg.exec(read(`prisma/migrations/${dir}/migration.sql`));
  }
  await server.start();
  const port = server.getServerConn().split(":").pop();
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, max: 1 }) });
  [owner, admin, editor, viewer, outsider] = await Promise.all(["olivia", "adam", "edith", "victor", "oscar"].map(user));
}, 60_000);
afterAll(async () => { await db?.$disconnect(); await server.stop(); await pg.close(); });

describe("POST /api/projects", () => {
  it("creates the project and an empty main branch in the contract's shape", async () => {
    const result = await create(owner, "Sonata in D", "For violin");
    expect(createProjectResponseSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      project: { name: "Sonata in D", slug: "sonata-in-d", description: "For violin", role: "owner", defaultBranch: "main" },
      branch: { name: "main", headHash: null, headMessage: null, archived: false },
    });
  });

  it("makes slugs unique per owner with -2, -3", async () => {
    expect((await create(owner, "Etude")).project.slug).toBe("etude");
    expect((await create(owner, "Étude!")).project.slug).toBe("etude-2");
    expect((await create(owner, "etude")).project.slug).toBe("etude-3");
    expect((await create(admin, "Etude")).project.slug).toBe("etude");
    expect((await create(owner, "♪♪")).project.slug).toBe("project");
  });

  it("requires a username", async () => {
    expect(await failure(create(randomUUID(), "No name"))).toBe("422 VALIDATION_FAILED");
  });
});

describe("GET /api/projects and /api/projects/:id", () => {
  it("lists owned and member projects with roles and the default branch head", async () => {
    const { project } = await create(admin, "Shared");
    await member(project.id, viewer, "VIEWER");
    const hash = await commitOnMain(project.id, "First draft");

    const list = await projects.listProjects(viewer, db);
    expect(listProjectsResponseSchema.parse(list)).toEqual(list);
    expect(list.projects).toEqual([expect.objectContaining({
      id: project.id, role: "viewer", head: { name: "main", headHash: hash, headMessage: "First draft", archived: false },
    })]);
  });

  it("returns the project with its active branches, and 404s for outsiders and bad ids", async () => {
    const { project } = await create(owner, "Detail");
    const result = await projects.getProject(owner, project.id, db);
    expect(getProjectResponseSchema.parse(result)).toEqual(result);
    expect(result.branches.map((b) => b.name)).toEqual(["main"]);
    expect(await failure(projects.getProject(outsider, project.id, db))).toBe("404 NOT_FOUND");
    expect(await failure(projects.getProject(owner, "not-a-uuid", db))).toBe("404 NOT_FOUND");
  });
});

describe("branches", () => {
  async function setup() {
    const { project } = await create(owner, "Branchy");
    await member(project.id, admin, "ADMIN");
    await member(project.id, editor, "EDITOR");
    await member(project.id, viewer, "VIEWER");
    const hash = await commitOnMain(project.id, "Bar 12 fixed");
    return { id: project.id, hash };
  }

  it("lets editors create a branch from a hash prefix, and rejects duplicates and viewers", async () => {
    const { id, hash } = await setup();
    await expect(projects.createBranch(editor, id, { name: "alto/rewrite", fromHash: hash.slice(0, 7) }, db))
      .resolves.toEqual({ branch: { name: "alto/rewrite", headHash: hash, headMessage: "Bar 12 fixed", archived: false } });
    expect(await failure(projects.createBranch(editor, id, { name: "alto/rewrite", fromHash: hash }, db))).toBe("409 BRANCH_EXISTS");
    expect(await failure(projects.createBranch(viewer, id, { name: "v", fromHash: hash }, db))).toBe("403 FORBIDDEN");
    expect(await failure(projects.createBranch(editor, id, { name: "x", fromHash: "abcdef0" }, db))).toBe("404 NOT_FOUND");
  });

  it("reports ambiguous hash prefixes", async () => {
    const { id } = await setup();
    await commitOnMain(id, "a", "abcdef1" + "0".repeat(57));
    await commitOnMain(id, "b", "abcdef1" + "1".repeat(57));
    expect(await failure(projects.createBranch(editor, id, { name: "amb", fromHash: "abcdef1" }, db))).toBe("409 AMBIGUOUS_HASH");
  });

  it("lets admins archive and unarchive, hides archived branches by default, and protects main", async () => {
    const { id, hash } = await setup();
    await projects.createBranch(editor, id, { name: "old", fromHash: hash }, db);

    expect(await failure(projects.setBranchArchived(editor, id, "old", true, db))).toBe("403 FORBIDDEN");
    await expect(projects.setBranchArchived(admin, id, "old", true, db)).resolves.toMatchObject({ branch: { archived: true } });
    expect((await projects.listBranches(viewer, id, false, db)).branches.map((b) => b.name)).toEqual(["main"]);
    expect((await projects.listBranches(viewer, id, true, db)).branches.map((b) => b.name)).toEqual(["main", "old"]);
    await expect(projects.setBranchArchived(admin, id, "old", false, db)).resolves.toMatchObject({ branch: { archived: false } });

    expect(await failure(projects.setBranchArchived(owner, id, "main", true, db))).toBe("422 VALIDATION_FAILED");
    expect(await failure(projects.setBranchArchived(admin, id, "missing", true, db))).toBe("404 NOT_FOUND");
  });
});

describe("GET /api/projects/:id/sync", () => {
  /** Inserts a commit with the given parents (in order) and returns its id and hash. */
  async function commit(projectId: string, message: string, parents: string[] = []) {
    const hash = createHash("sha256").update(randomUUID()).digest("hex");
    const [{ id }] = (await pg.query<{ id: string }>("insert into commits (project_id, message, hash) values ($1, $2, $3) returning id", [projectId, message, hash])).rows;
    for (const [position, parent] of parents.entries()) {
      await pg.query("insert into commit_parents (commit_id, parent_id, position) values ($1, $2, $3)", [id, parent, position]);
    }
    return { id, hash };
  }
  const point = (projectId: string, branch: string, commitId: string) =>
    pg.query("update branches set head_commit_id = $1 where project_id = $2 and name = $3", [commitId, projectId, branch]);
  const sync = (userId: string, projectId: string, query: { branch?: string; commit?: string; includeArchived?: "0" | "1" }) =>
    projects.sync(userId, projectId, syncQuerySchema.parse(query), db);

  it("answers none, empty, same, behind, and unrelated", async () => {
    const { project } = await create(owner, "Synced");
    await member(project.id, viewer, "VIEWER");
    const id = project.id;

    expect(await sync(viewer, id, {})).toMatchObject({ relation: "none", commitsAhead: 0, role: "viewer" });
    expect((await sync(viewer, id, { commit: "abcdef0" })).relation).toBe("empty");

    // c1 <- c2 <- c3 (main); c2 <- side (branch "side")
    const c1 = await commit(id, "one");
    const c2 = await commit(id, "two", [c1.id]);
    const c3 = await commit(id, "three", [c2.id]);
    const side = await commit(id, "side", [c2.id]);
    await point(id, "main", c3.id);
    await pg.query("insert into branches (project_id, name, head_commit_id) values ($1, 'side', $2)", [id, side.id]);

    const same = await sync(viewer, id, { commit: c3.hash.slice(0, 7) });
    expect(syncResponseSchema.parse(same)).toEqual(same);
    expect(same).toMatchObject({ relation: "same", commitsAhead: 0, branch: { name: "main", headHash: c3.hash, headMessage: "three" } });
    expect(same.branches.map((b) => b.name)).toEqual(["main", "side"]);
    expect(await sync(viewer, id, { commit: c1.hash })).toMatchObject({ relation: "behind", commitsAhead: 2 });
    expect(await sync(viewer, id, { commit: side.hash })).toMatchObject({ relation: "unrelated", commitsAhead: 0 });
    expect(await sync(viewer, id, { branch: "side", commit: c2.hash })).toMatchObject({ relation: "behind", commitsAhead: 1 });
    expect((await sync(viewer, id, { commit: "f".repeat(64) })).relation).toBe("unrelated");
  });

  it("follows both parents of a merge commit", async () => {
    const { project } = await create(owner, "Merged");
    const id = project.id;
    const base = await commit(id, "base");
    const a = await commit(id, "a", [base.id]);
    const b = await commit(id, "b", [base.id]);
    const merge = await commit(id, "merge", [a.id, b.id]);
    await point(id, "main", merge.id);
    // From b, the head has merge and a that b doesn't.
    expect(await sync(owner, id, { commit: b.hash })).toMatchObject({ relation: "behind", commitsAhead: 2 });
  });

  it("404s for a missing branch or an outsider and hides archived branches unless asked", async () => {
    const { project } = await create(owner, "Guarded");
    const c = await commit(project.id, "c");
    await point(project.id, "main", c.id);
    await projects.createBranch(owner, project.id, { name: "gone", fromHash: c.hash }, db);
    await projects.setBranchArchived(owner, project.id, "gone", true, db);

    expect((await sync(owner, project.id, {})).branches.map((b) => b.name)).toEqual(["main"]);
    expect((await sync(owner, project.id, { includeArchived: "1" })).branches.map((b) => b.name)).toEqual(["gone", "main"]);
    expect(await failure(sync(owner, project.id, { branch: "nope" }))).toBe("404 NOT_FOUND");
    expect(await failure(sync(outsider, project.id, {}))).toBe("404 NOT_FOUND");
  });
});

describe("GET /api/projects/:id/branches/:name/commits", () => {
  async function commit(projectId: string, message: string, parents: string[] = [], authorId: string | null = null) {
    const hash = createHash("sha256").update(randomUUID()).digest("hex");
    const [{ id }] = (await pg.query<{ id: string }>("insert into commits (project_id, message, hash, author_id) values ($1, $2, $3, $4) returning id", [projectId, message, hash, authorId])).rows;
    for (const [position, parent] of parents.entries()) {
      await pg.query("insert into commit_parents (commit_id, parent_id, position) values ($1, $2, $3)", [id, parent, position]);
    }
    return { id, hash };
  }
  const history = (userId: string, projectId: string, branch: string, query: { limit?: string; cursor?: string } = {}) =>
    projects.history(userId, projectId, branch, historyQuerySchema.parse(query), db);

  it("pages newest first along first parents, listing both parents of a merge", async () => {
    const { project } = await create(owner, "Historic");
    const id = project.id;
    const c1 = await commit(id, "one", [], owner);
    const c2 = await commit(id, "two", [c1.id], owner);
    const side = await commit(id, "side work", [c1.id]);
    const merge = await commit(id, "merge side", [c2.id, side.id], owner);
    await pg.query("update branches set head_commit_id = $1 where project_id = $2 and name = 'main'", [merge.id, id]);

    const first = await history(owner, id, "main", { limit: "2" });
    expect(historyResponseSchema.parse(first)).toEqual(first);
    expect(first.commits.map((c) => c.message)).toEqual(["merge side", "two"]);
    expect(first.commits[0]).toMatchObject({ shortHash: merge.hash.slice(0, 7), parents: [c2.hash, side.hash], author: { id: owner, username: "olivia" } });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await history(owner, id, "main", { limit: "2", cursor: first.nextCursor! });
    expect(second).toMatchObject({ commits: [{ message: "one", parents: [], author: { username: "olivia" } }], nextCursor: null });
    expect((await history(owner, id, "main")).commits.map((c) => c.message)).toEqual(["merge side", "two", "one"]);
  });

  it("returns nothing for an empty branch and rejects bad cursors, missing branches, and outsiders", async () => {
    const { project } = await create(owner, "Blank");
    expect(await history(owner, project.id, "main")).toEqual({ commits: [], nextCursor: null });
    expect(await failure(history(owner, project.id, "main", { cursor: "bm9wZQ" }))).toBe("400 INVALID_REQUEST");
    expect(await failure(history(owner, project.id, "nope"))).toBe("404 NOT_FOUND");
    expect(await failure(history(outsider, project.id, "main"))).toBe("404 NOT_FOUND");
  });
});

describe("GET /api/projects/:id/commits/:hash", () => {
  it("returns the commit with its files, by full hash or prefix", async () => {
    const { project } = await create(owner, "Detailed");
    await member(project.id, viewer, "VIEWER");
    const sha = createHash("sha256").update("score").digest("hex");
    const [{ id: blobId }] = (await pg.query<{ id: string }>(
      "insert into blobs (project_id, sha256, size_bytes, content_type, storage_path) values ($1, $2, 1234, 'application/vnd.recordare.musicxml+xml', $3) returning id",
      [project.id, sha, `${project.id}/${sha}`])).rows;
    const hash = await commitOnMain(project.id, "Add score");
    const [{ id: commitId }] = (await pg.query<{ id: string }>("select id from commits where hash = $1", [hash])).rows;
    await pg.query("insert into commit_files (commit_id, path, blob_id) values ($1, 'score.musicxml', $2), ($1, 'parts/a.musicxml', $2)", [commitId, blobId]);
    await pg.query("update commits set ai_summary = 'Adds the score.' where id = $1", [commitId]);

    const result = await projects.commitDetail(viewer, project.id, hash.slice(0, 9), db);
    expect(commitDetailResponseSchema.parse(result)).toEqual(result);
    expect(result.commit).toMatchObject({
      hash, message: "Add score", aiSummary: "Adds the score.", parents: [],
      files: [
        { path: "parts/a.musicxml", format: "MUSICXML", role: "primary", sha256: sha, size: 1234 },
        { path: "score.musicxml", format: "MUSICXML", role: "primary", sha256: sha, size: 1234 },
      ],
    });
    expect(await failure(projects.commitDetail(viewer, project.id, "0000000", db))).toBe("404 NOT_FOUND");
    expect(await failure(projects.commitDetail(outsider, project.id, hash, db))).toBe("404 NOT_FOUND");
  });
});

describe("GET /api/projects/:id/blobs/:sha256", () => {
  it("returns a project's file from storage and 404s for other projects' files and outsiders", async () => {
    const { project } = await create(owner, "Files");
    const other = await create(admin, "Elsewhere");
    const bytes = new TextEncoder().encode("<score-partwise/>");
    const sha = createHash("sha256").update(bytes).digest("hex");
    await pg.query("insert into blobs (project_id, sha256, size_bytes, content_type, storage_path) values ($1, $2, $3, 'application/xml', $4)",
      [project.id, sha, bytes.byteLength, `${project.id}/${sha}`]);
    const download = vi.fn(async () => bytes);

    await expect(projects.getBlob(owner, project.id, sha, db, download))
      .resolves.toEqual({ sha256: sha, size: bytes.byteLength, contentType: "application/xml", bytes });
    expect(download).toHaveBeenCalledWith(`${project.id}/${sha}`);
    expect(await failure(projects.getBlob(admin, other.project.id, sha, db, download))).toBe("404 NOT_FOUND");
    expect(await failure(projects.getBlob(outsider, project.id, sha, db, download))).toBe("404 NOT_FOUND");
    expect(download).toHaveBeenCalledTimes(1);
  });
});
