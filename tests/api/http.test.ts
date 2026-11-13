import { readdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";

// Every project API route end to end through its real Next.js route module: auth wrapper, body and
// multipart parsing, validation, service, and Postgres (PGlite with all migrations). Only Supabase is
// faked: bearer tokens map straight to user ids, and Storage is an in-memory map.
const state = vi.hoisted(() => ({ db: undefined as unknown, users: new Map<string, string>(), objects: new Map<string, Uint8Array>() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/api/auth", async (original) => {
  const { unauthenticated } = await import("@/lib/auth/errors");
  return {
    ...(await original<typeof import("@/lib/api/auth")>()),
    verifyAccessToken: async (token: string) => {
      const id = state.users.get(token);
      if (!id) throw unauthenticated();
      return { id, email: `${id}@example.com`, emailVerified: true };
    },
  };
});
vi.mock("@/lib/storage", () => ({
  blobPath: (projectId: string, sha: string) => `${projectId}/${sha}`,
  uploadBlob: async (path: string, bytes: Uint8Array) => { state.objects.set(path, bytes); },
  downloadBlob: async (path: string) => state.objects.get(path)!,
}));

import * as projectsRoute from "@/app/api/projects/route";
import * as projectRoute from "@/app/api/projects/[id]/route";
import * as branchesRoute from "@/app/api/projects/[id]/branches/route";
import * as branchRoute from "@/app/api/projects/[id]/branches/[...name]/route";
import * as syncRoute from "@/app/api/projects/[id]/sync/route";
import * as commitsRoute from "@/app/api/projects/[id]/commits/route";
import * as commitRoute from "@/app/api/projects/[id]/commits/[hash]/route";
import * as blobRoute from "@/app/api/projects/[id]/blobs/[sha256]/route";
import * as suggestRoute from "@/app/api/projects/[id]/commit-message-suggestions/route";

const pg = new PGlite();
const server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1" });
let prisma: PrismaClient;
const ORIGIN = "http://localhost:3000";
const jwt = (name: string) => ["e30", Buffer.from(JSON.stringify({ sub: name, exp: 4_000_000_000 })).toString("base64url"), name].join(".");
const ctx = <T,>(params: T) => ({ params: Promise.resolve(params) });

type Init = { token?: string; json?: unknown; form?: FormData; headers?: Record<string, string> };
function req(method: string, path: string, { token, json, form, headers = {} }: Init = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : form,
  });
}
async function body(response: Response) {
  return { status: response.status, json: await response.json(), headers: response.headers };
}
const score = (bars: string[]) => new TextEncoder().encode(
  `<score-partwise><work><work-title>Etude</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>` +
  `<part id="P1">${bars.map((b, i) => `<measure number="${i + 1}">${b}</measure>`).join("")}</part></score-partwise>`);
function commitForm(metadata: unknown, files: Record<string, Uint8Array>) {
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  for (const [field, bytes] of Object.entries(files)) form.set(field, new Blob([new Uint8Array(bytes)]), "score.musicxml");
  return form;
}

let editor: string, viewer: string;
const OWNER = jwt("owner"), EDITOR = jwt("editor"), VIEWER = jwt("viewer"), STRANGER = jwt("stranger");

beforeAll(async () => {
  await pg.exec("alter database postgres set timezone to 'UTC'; set timezone to 'UTC';");
  await pg.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;");
  for (const dir of readdirSync(new URL("../../prisma/migrations", import.meta.url)).filter((d) => /^\d/.test(d)).sort()) {
    await pg.exec(readFileSync(new URL(`../../prisma/migrations/${dir}/migration.sql`, import.meta.url), "utf8"));
  }
  await server.start();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres@127.0.0.1:${server.getServerConn().split(":").pop()}/postgres`, max: 1 }) });
  state.db = prisma;
  for (const [token, name] of [[OWNER, "olivia"], [EDITOR, "edith"], [VIEWER, "victor"], [STRANGER, "sam"]]) {
    const id = randomUUID();
    await pg.query("insert into users (id, username) values ($1, $2)", [id, name]);
    state.users.set(token, id);
  }
  [editor, viewer] = [EDITOR, VIEWER].map((t) => state.users.get(t)!);
}, 60_000);
afterAll(async () => { await prisma?.$disconnect(); await server.stop(); await pg.close(); });
beforeEach(() => { vi.stubEnv("APP_ORIGIN", ORIGIN); vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("project API over HTTP", () => {
  it("runs the plugin's whole flow: create, commit, sync, history, pull, branch, fork, suggest", async () => {
    // Create a project.
    const created = await body(await projectsRoute.POST(req("POST", "/api/projects", { token: OWNER, json: { name: "Étude No. 1" } })));
    expect(created).toMatchObject({ status: 201, json: { data: { project: { slug: "etude-no-1", role: "owner" }, branch: { name: "main", headHash: null } } } });
    expect(created.headers.get("cache-control")).toContain("no-store");
    const id: string = created.json.data.project.id;
    await pg.query("insert into project_members (project_id, user_id, role) values ($1, $2, 'EDITOR'), ($1, $3, 'VIEWER')", [id, editor, viewer]);

    // Listing and reading.
    expect((await body(await projectsRoute.GET(req("GET", "/api/projects", { token: EDITOR })))).json.data.projects)
      .toEqual([expect.objectContaining({ id, role: "editor", head: { name: "main", headHash: null, headMessage: null, archived: false } })]);
    expect((await body(await projectRoute.GET(req("GET", `/api/projects/${id}`, { token: VIEWER }), ctx({ id })))).json.data)
      .toMatchObject({ project: { role: "viewer" }, branches: [{ name: "main" }] });

    // Suggest, then make the first commit (multipart) with an Idempotency-Key.
    const v1 = score(["c", "d", "e"]);
    const files = [{ field: "f0", path: "etude.musicxml" }];
    const suggestion = await body(await suggestRoute.POST(req("POST", `/api/projects/${id}/commit-message-suggestions`, {
      token: EDITOR, form: commitForm({ branch: "main", parentHash: null, files }, { f0: v1 }) }), ctx({ id })));
    expect(suggestion).toMatchObject({ status: 200, json: { data: { suggestion: "Add Etude (Piano)", basis: "initial_commit" } } });

    const first = await body(await commitsRoute.POST(req("POST", `/api/projects/${id}/commits`, {
      token: EDITOR, headers: { "idempotency-key": "first-commit-1" },
      form: commitForm({ branch: "main", parentHash: null, message: "Add Etude (Piano)", files }, { f0: v1 }) }), ctx({ id })));
    expect(first).toMatchObject({ status: 201, json: { data: { commit: { message: "Add Etude (Piano)", parents: [] }, branch: { created: false } } } });
    const c1: string = first.json.data.commit.hash;
    const replay = await body(await commitsRoute.POST(req("POST", `/api/projects/${id}/commits`, {
      token: EDITOR, headers: { "idempotency-key": "first-commit-1" },
      form: commitForm({ branch: "main", parentHash: null, message: "Add Etude (Piano)", files }, { f0: v1 }) }), ctx({ id })));
    expect(replay).toMatchObject({ status: 201, json: first.json });

    // Sync says "same"; a second commit moves main; the old commit is now "behind".
    expect((await body(await syncRoute.GET(req("GET", `/api/projects/${id}/sync?commit=${c1.slice(0, 7)}`, { token: VIEWER }), ctx({ id })))).json.data)
      .toMatchObject({ relation: "same", commitsAhead: 0, role: "viewer" });
    const v2 = score(["c", "D", "e", "f"]);
    const nextSuggestion = await body(await suggestRoute.POST(req("POST", `/api/projects/${id}/commit-message-suggestions`, {
      token: EDITOR, form: commitForm({ branch: "main", parentHash: c1, files }, { f0: v2 }) }), ctx({ id })));
    expect(nextSuggestion.json.data).toMatchObject({ suggestion: "Edit bars 2, 4 in Piano; add 1 measure", basis: "simple_diff" });
    const second = await body(await commitsRoute.POST(req("POST", `/api/projects/${id}/commits`, {
      token: OWNER, form: commitForm({ branch: "main", parentHash: c1, message: "Fix bar 2", files }, { f0: v2 }) }), ctx({ id })));
    const c2: string = second.json.data.commit.hash;
    expect((await body(await syncRoute.GET(req("GET", `/api/projects/${id}/sync?commit=${c1}`, { token: VIEWER }), ctx({ id })))).json.data)
      .toMatchObject({ relation: "behind", commitsAhead: 1, branch: { headHash: c2 } });

    // A commit from the old parent is stale; resending with newBranch forks.
    const stale = await body(await commitsRoute.POST(req("POST", `/api/projects/${id}/commits`, {
      token: EDITOR, form: commitForm({ branch: "main", parentHash: c1, message: "My take", files }, { f0: score(["x"]) }) }), ctx({ id })));
    expect(stale).toMatchObject({ status: 409, json: { error: { code: "STALE_PARENT", details: { headHash: c2, yourParent: c1, commitsAhead: 1 } } } });
    const fork = await body(await commitsRoute.POST(req("POST", `/api/projects/${id}/commits`, {
      token: EDITOR, form: commitForm({ branch: "main", parentHash: c1, newBranch: { name: "edith/take" }, message: "My take", files }, { f0: score(["x"]) }) }), ctx({ id })));
    expect(fork).toMatchObject({ status: 201, json: { data: { branch: { name: "edith/take", created: true }, commit: { parents: [c1] } } } });

    // History through the catch-all route (branch name with a slash), with pagination.
    const page1 = await body(await branchRoute.GET(req("GET", `/api/projects/${id}/branches/main/commits?limit=1`, { token: VIEWER }), ctx({ id, name: ["main", "commits"] })));
    expect(page1.json.data.commits.map((c: { hash: string }) => c.hash)).toEqual([c2]);
    const page2 = await body(await branchRoute.GET(req("GET", `/api/projects/${id}/branches/main/commits?limit=1&cursor=${page1.json.data.nextCursor}`, { token: VIEWER }), ctx({ id, name: ["main", "commits"] })));
    expect(page2.json.data).toMatchObject({ commits: [{ hash: c1 }], nextCursor: null });
    const forkHistory = await body(await branchRoute.GET(req("GET", `/api/projects/${id}/branches/edith%2Ftake/commits`, { token: VIEWER }), ctx({ id, name: ["edith", "take", "commits"] })));
    expect(forkHistory.json.data.commits.map((c: { message: string }) => c.message)).toEqual(["My take", "Add Etude (Piano)"]);

    // Pull: commit detail, then the file as raw bytes and as base64.
    const detail = await body(await commitRoute.GET(req("GET", `/api/projects/${id}/commits/${c1.slice(0, 8)}`, { token: VIEWER }), ctx({ id, hash: c1.slice(0, 8) })));
    const sha = createHash("sha256").update(v1).digest("hex");
    expect(detail.json.data.commit).toMatchObject({ hash: c1, files: [{ path: "etude.musicxml", sha256: sha, size: v1.byteLength, role: "primary", format: "MUSICXML" }] });
    const raw = await blobRoute.GET(req("GET", `/api/projects/${id}/blobs/${sha}`, { token: VIEWER }), ctx({ id, sha256: sha }));
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("application/vnd.recordare.musicxml+xml");
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(v1);
    const b64 = await body(await blobRoute.GET(req("GET", `/api/projects/${id}/blobs/${sha}?encoding=base64`, { token: VIEWER }), ctx({ id, sha256: sha })));
    expect(Buffer.from(b64.json.data.base64, "base64")).toEqual(Buffer.from(v1));

    // Branches: create from a hash, list, archive (admin+), hidden unless asked.
    expect((await body(await branchesRoute.POST(req("POST", `/api/projects/${id}/branches`, { token: EDITOR, json: { name: "old", fromHash: c1.slice(0, 7) } }), ctx({ id })))).status).toBe(201);
    expect((await body(await branchRoute.PATCH(req("PATCH", `/api/projects/${id}/branches/old`, { token: EDITOR, json: { archived: true } }), ctx({ id, name: ["old"] })))).status).toBe(403);
    expect((await body(await branchRoute.PATCH(req("PATCH", `/api/projects/${id}/branches/old`, { token: OWNER, json: { archived: true } }), ctx({ id, name: ["old"] })))).json.data.branch.archived).toBe(true);
    const names = async (q: string) => (await body(await branchesRoute.GET(req("GET", `/api/projects/${id}/branches${q}`, { token: VIEWER }), ctx({ id })))).json.data.branches.map((b: { name: string }) => b.name);
    expect(await names("")).toEqual(["edith/take", "main"]);
    expect(await names("?includeArchived=1")).toEqual(["edith/take", "main", "old"]);
  });

  it("rejects bad auth, outsiders, cross-site cookie writes, and malformed input with contract errors", async () => {
    const { json } = await body(await projectsRoute.POST(req("POST", "/api/projects", { token: OWNER, json: { name: "Guarded" } })));
    const id: string = json.data.project.id;
    const code = async (response: Promise<Response> | Response) => { const r = await body(await response); return `${r.status} ${r.json.error.code}`; };

    expect(await code(projectsRoute.GET(req("GET", "/api/projects", { headers: { authorization: "Bearer nope" } })))).toBe("401 UNAUTHENTICATED");
    // TOKEN_EXPIRED comes from the real verifyAccessToken, which is faked here; tests/api/core.test.ts covers it.
    expect(await code(projectRoute.GET(req("GET", `/api/projects/${id}`, { token: STRANGER }), ctx({ id })))).toBe("404 NOT_FOUND");
    expect(await code(projectRoute.GET(req("GET", "/api/projects/not-a-uuid", { token: OWNER }), ctx({ id: "not-a-uuid" })))).toBe("404 NOT_FOUND");
    expect(await code(projectsRoute.POST(req("POST", "/api/projects", { token: OWNER, json: { name: "" } })))).toBe("400 INVALID_REQUEST");
    // Cookie callers (no bearer) get the origin check on writes.
    expect(await code(projectsRoute.POST(req("POST", "/api/projects", { json: { name: "X" }, headers: { origin: "https://evil.example" } })))).toBe("403 ORIGIN_NOT_ALLOWED");
    expect(await code(commitsRoute.POST(req("POST", `/api/projects/${id}/commits`, { token: OWNER, json: {} }), ctx({ id })))).toBe("415 UNSUPPORTED_MEDIA_TYPE");
    const tooMany = commitForm({ branch: "main", parentHash: null, message: "m", files: Array.from({ length: 101 }, (_, i) => ({ field: `f${i}`, path: `f${i}.xml` })) }, {});
    expect(await code(commitsRoute.POST(req("POST", `/api/projects/${id}/commits`, { token: OWNER, form: tooMany }), ctx({ id })))).toBe("413 TOO_MANY_FILES");
    expect(await code(commitsRoute.POST(req("POST", `/api/projects/${id}/commits`, { token: OWNER, headers: { "idempotency-key": "bad key!" },
      form: commitForm({ branch: "main", parentHash: null, message: "m", files: [{ field: "f0", path: "a.xml" }] }, { f0: score(["a"]) }) }), ctx({ id })))).toBe("400 INVALID_REQUEST");
    expect(await code(syncRoute.GET(req("GET", `/api/projects/${id}/sync?branch=nope`, { token: OWNER }), ctx({ id })))).toBe("404 NOT_FOUND");
    expect(await code(branchRoute.GET(req("GET", `/api/projects/${id}/branches/main`, { token: OWNER }), ctx({ id, name: ["main"] })))).toBe("404 NOT_FOUND");
    expect(await code(blobRoute.GET(req("GET", `/api/projects/${id}/blobs/${"a".repeat(64)}`, { token: OWNER }), ctx({ id, sha256: "a".repeat(64) })))).toBe("404 NOT_FOUND");
    expect(await code(commitRoute.GET(req("GET", `/api/projects/${id}/commits/xyz`, { token: OWNER }), ctx({ id, hash: "xyz" })))).toBe("404 NOT_FOUND");
  });
});
