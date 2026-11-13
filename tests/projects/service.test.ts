import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";

// Runs the real project service against embedded Postgres with the real migrations, through
// the same Prisma adapter the app uses. PGlite is served over a local socket so node-postgres can connect.
const state = vi.hoisted(() => ({ prisma: undefined as unknown }));
vi.mock("@/lib/db", () => ({
  getDb: () => state.prisma,
  isUniqueViolation: (error: unknown) => (error as { code?: string } | null)?.code === "P2002",
}));
import * as projects from "@/lib/projects/service";
import { HttpError } from "@/lib/api/errors";

const pg = new PGlite();
const server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1" });
let prisma: PrismaClient;
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

async function user(username: string) {
  const id = randomUUID();
  await pg.query("insert into users (id, username) values ($1, $2)", [id, username]);
  return id;
}

/** Resolves to the HttpError code and status a call throws. */
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return `${error.status} ${error.code}`;
    throw error;
  }
  throw new Error("Expected the call to fail.");
}

let owner: string, admin: string, editor: string, viewer: string, outsider: string, noUsername: string;

beforeAll(async () => {
  // Roles referenced by the RLS statements in init_schema. No auth schema, so the users sync
  // migration skips itself, as it does on plain Postgres.
  await pg.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  await pg.exec(read("prisma/migrations/20261027000000_init_schema/migration.sql"));
  await pg.exec(read("prisma/migrations/20261027000100_users_sync_triggers/migration.sql"));
  await server.start();
  // getServerConn() is "host:port"; port 0 asked the OS for a free one.
  const port = server.getServerConn().split(":").pop();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, max: 1 }) });
  state.prisma = prisma;
  [owner, admin, editor, viewer, outsider] = await Promise.all(["olivia", "adam", "edith", "victor", "oscar"].map(user));
  noUsername = randomUUID();
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await server.stop();
  await pg.close();
});

describe("projects", () => {
  it("creates a private project with an empty main branch and a slug from its name", async () => {
    const project = await projects.createProject(owner, { name: "Symphony No. 1 in C minor" });
    expect(project).toMatchObject({
      slug: "symphony-no-1-in-c-minor", visibility: "PRIVATE", defaultBranch: "main", role: "OWNER",
      owner: { id: owner, username: "olivia" }, archivedAt: null,
    });
    const branches = await prisma.branch.findMany({ where: { projectId: project.id } });
    expect(branches).toMatchObject([{ name: "main", headCommitId: null, createdById: owner }]);
  });

  it("rejects a duplicate slug for the same owner but allows it for another", async () => {
    await projects.createProject(owner, { name: "Quartet", slug: "quartet" });
    expect(await failure(projects.createProject(owner, { name: "Other", slug: "quartet" }))).toBe("409 SLUG_TAKEN");
    await expect(projects.createProject(admin, { name: "Quartet" })).resolves.toMatchObject({ slug: "quartet" });
  });

  it("requires a username and a usable slug", async () => {
    expect(await failure(projects.createProject(noUsername, { name: "Mine" }))).toBe("403 USERNAME_REQUIRED");
    expect(await failure(projects.createProject(owner, { name: "♪♪♪" }))).toBe("409 SLUG_REQUIRED");
  });

  it("hides private projects from outsiders as not found and shows public ones read-only", async () => {
    const hidden = await projects.createProject(owner, { name: "Secret" });
    const shown = await projects.createProject(owner, { name: "Open", visibility: "PUBLIC" });
    expect(await failure(projects.getProject(outsider, hidden.id))).toBe("404 PROJECT_NOT_FOUND");
    expect(await failure(projects.findProjectBySlug(outsider, "olivia", "secret"))).toBe("404 PROJECT_NOT_FOUND");
    await expect(projects.findProjectBySlug(outsider, "olivia", "open")).resolves.toMatchObject({ id: shown.id, role: null });
    expect(await failure(projects.updateProject(outsider, shown.id, { name: "Mine now" }))).toBe("403 FORBIDDEN");
    expect(await failure(projects.getProject(owner, randomUUID()))).toBe("404 PROJECT_NOT_FOUND");
  });

  it("lists owned and member projects with roles, hiding archived ones by default", async () => {
    const shared = await projects.createProject(admin, { name: "Shared with Victor" });
    await projects.addMember(admin, shared.id, { username: "victor", role: "VIEWER" });
    const archived = await projects.createProject(viewer, { name: "Old" });
    await projects.updateProject(viewer, archived.id, { archived: true });

    const list = await projects.listProjects(viewer);
    expect(list.map((p) => [p.name, p.role])).toEqual([["Shared with Victor", "VIEWER"]]);
    const all = await projects.listProjects(viewer, { includeArchived: true });
    expect(all.map((p) => p.name).sort()).toEqual(["Old", "Shared with Victor"]);
    expect(all.find((p) => p.name === "Old")?.archivedAt).toBeInstanceOf(Date);
  });

  it("lets admins edit settings but only the owner delete, and deletion removes the project", async () => {
    const project = await projects.createProject(owner, { name: "Editable" });
    await projects.addMember(owner, project.id, { username: "adam", role: "ADMIN" });
    await projects.addMember(owner, project.id, { username: "edith", role: "EDITOR" });

    await expect(projects.updateProject(admin, project.id, { name: "Renamed", visibility: "PUBLIC", description: null }))
      .resolves.toMatchObject({ name: "Renamed", visibility: "PUBLIC", role: "ADMIN" });
    expect(await failure(projects.updateProject(editor, project.id, { name: "No" }))).toBe("403 FORBIDDEN");
    expect(await failure(projects.deleteProject(admin, project.id))).toBe("403 FORBIDDEN");

    await projects.deleteProject(owner, project.id);
    expect(await prisma.project.count({ where: { id: project.id } })).toBe(0);
    expect(await prisma.branch.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.projectMember.count({ where: { projectId: project.id } })).toBe(0);
  });
});

describe("members", () => {
  it("adds, lists, re-roles, and removes members with the owner listed separately", async () => {
    const project = await projects.createProject(owner, { name: "Members" });
    await projects.addMember(owner, project.id, { username: "edith", role: "EDITOR" });
    await projects.addMember(owner, project.id, { username: "victor", role: "VIEWER" });

    const listed = await projects.listMembers(viewer, project.id);
    expect(listed.owner).toEqual({ id: owner, username: "olivia" });
    expect(listed.members.map((m) => [m.user.username, m.role])).toEqual([["edith", "EDITOR"], ["victor", "VIEWER"]]);

    await expect(projects.updateMember(owner, project.id, viewer, { role: "EDITOR" })).resolves.toMatchObject({ role: "EDITOR" });
    await projects.removeMember(owner, project.id, viewer);
    expect(await failure(projects.getProject(viewer, project.id))).toBe("404 PROJECT_NOT_FOUND");
  });

  it("rejects unknown users, the owner, and duplicates", async () => {
    const project = await projects.createProject(owner, { name: "Dupes" });
    await projects.addMember(owner, project.id, { username: "edith", role: "EDITOR" });
    expect(await failure(projects.addMember(owner, project.id, { username: "nobody", role: "EDITOR" }))).toBe("404 USER_NOT_FOUND");
    expect(await failure(projects.addMember(owner, project.id, { username: "olivia", role: "EDITOR" }))).toBe("409 ALREADY_OWNER");
    expect(await failure(projects.addMember(owner, project.id, { username: "edith", role: "VIEWER" }))).toBe("409 ALREADY_MEMBER");
    expect(await failure(projects.updateMember(owner, project.id, outsider, { role: "VIEWER" }))).toBe("404 MEMBER_NOT_FOUND");
  });

  it("lets admins manage editors and viewers but reserves admin changes for the owner", async () => {
    const project = await projects.createProject(owner, { name: "Admins" });
    await projects.addMember(owner, project.id, { username: "adam", role: "ADMIN" });
    await projects.addMember(owner, project.id, { username: "oscar", role: "ADMIN" });

    await projects.addMember(admin, project.id, { username: "edith", role: "EDITOR" });
    await projects.updateMember(admin, project.id, editor, { role: "VIEWER" });
    await projects.removeMember(admin, project.id, editor);

    expect(await failure(projects.addMember(admin, project.id, { username: "victor", role: "ADMIN" }))).toBe("403 OWNER_REQUIRED");
    expect(await failure(projects.updateMember(admin, project.id, outsider, { role: "EDITOR" }))).toBe("403 OWNER_REQUIRED");
    expect(await failure(projects.removeMember(admin, project.id, outsider))).toBe("403 OWNER_REQUIRED");
    await projects.updateMember(owner, project.id, outsider, { role: "EDITOR" });
  });

  it("lets any member leave, and blocks editors and viewers from managing members", async () => {
    const project = await projects.createProject(owner, { name: "Leaving" });
    await projects.addMember(owner, project.id, { username: "edith", role: "EDITOR" });
    await projects.addMember(owner, project.id, { username: "victor", role: "VIEWER" });

    expect(await failure(projects.addMember(editor, project.id, { username: "oscar", role: "VIEWER" }))).toBe("403 FORBIDDEN");
    expect(await failure(projects.removeMember(editor, project.id, viewer))).toBe("403 FORBIDDEN");
    await projects.removeMember(viewer, project.id, viewer);
    expect(await failure(projects.listMembers(viewer, project.id))).toBe("404 PROJECT_NOT_FOUND");
    expect(await failure(projects.removeMember(outsider, project.id, editor))).toBe("404 PROJECT_NOT_FOUND");
  });
});
