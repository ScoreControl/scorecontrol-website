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
import { createProjectResponseSchema, getProjectResponseSchema, listProjectsResponseSchema } from "@/lib/api/contract";

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
