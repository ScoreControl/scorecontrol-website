import { describe, expect, it } from "vitest";
import {
  API_ERRORS, PROJECT_ROLES, apiErrorBodySchema, branchNameSchema, commitMetadataSchema, commitResponseSchema,
  createProjectRequestSchema, filePathSchema, hashRefSchema, historyQuerySchema, syncQuerySchema, syncResponseSchema,
} from "@/lib/api/contract";

const hash = (c: string) => c.repeat(64);
const file = { field: "f0", path: "sonata.musicxml", format: "MUSICXML", role: "primary" };
const commit = { branch: "main", parentHash: hash("a"), message: "Add second verse", files: [file] };

describe("branch names", () => {
  it.each(["main", "ryan-alt", "feature/verse-2", "v1.0", "A_B", "x".repeat(64)])("accepts %s", (name) => {
    expect(branchNameSchema.safeParse(name).success).toBe(true);
  });
  it.each(["", "x".repeat(65), "has space", "/lead", ".hidden", "trail/", "a..b", "a//b", "x.lock", "ünï"])("rejects %j", (name) => {
    expect(branchNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("hash refs and paths", () => {
  it("accepts full hashes and 7+ character prefixes, normalizing case", () => {
    expect(hashRefSchema.parse("ABCDEF1")).toBe("abcdef1");
    expect(hashRefSchema.safeParse(hash("f")).success).toBe(true);
    expect(hashRefSchema.safeParse("abc123").success).toBe(false);
    expect(hashRefSchema.safeParse("zzzzzzz").success).toBe(false);
  });
  it.each(["/abs.xml", "../up.xml", "a/./b.xml", "a//b.xml", "a\\b.xml", ""])("rejects path %j", (path) => {
    expect(filePathSchema.safeParse(path).success).toBe(false);
  });
});

describe("requests", () => {
  it("defaults the project format to MusicXML", () => {
    expect(createProjectRequestSchema.parse({ name: " Sonata in D " })).toEqual({ name: "Sonata in D", format: "MUSICXML" });
  });
  it("parses the PDF's commit example and defaults newBranch to null", () => {
    expect(commitMetadataSchema.parse(commit).newBranch).toBeNull();
    expect(commitMetadataSchema.parse({ ...commit, parentHash: null }).parentHash).toBeNull();
  });
  it("requires exactly one primary file and unique fields and paths", () => {
    const native = { field: "f1", path: "sonata.mscz", format: "MSCZ", role: "native" };
    expect(commitMetadataSchema.safeParse({ ...commit, files: [file, native] }).success).toBe(true);
    expect(commitMetadataSchema.safeParse({ ...commit, files: [native] }).success).toBe(false);
    expect(commitMetadataSchema.safeParse({ ...commit, files: [file, { ...file, path: "b.musicxml" }] }).success).toBe(false);
    expect(commitMetadataSchema.safeParse({ ...commit, files: [file, { ...native, path: file.path }] }).success).toBe(false);
  });
  it("rejects unknown fields so typos fail loudly", () => {
    expect(commitMetadataSchema.safeParse({ ...commit, parent: hash("a") }).success).toBe(false);
  });
  it("reads query strings", () => {
    expect(syncQuerySchema.parse({})).toEqual({ branch: "main", includeArchived: false });
    expect(syncQuerySchema.parse({ commit: "ABCDEF12", includeArchived: "1" }).includeArchived).toBe(true);
    expect(historyQuerySchema.parse({ limit: "5" }).limit).toBe(5);
    expect(historyQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });
});

describe("responses", () => {
  const branch = { name: "main", headHash: hash("b"), headMessage: "Fix bar 12", archived: false };
  it("validates the sync example", () => {
    expect(syncResponseSchema.safeParse({ branch, relation: "behind", commitsAhead: 2, branches: [branch], role: "editor" }).success).toBe(true);
  });
  it("validates the commit example", () => {
    expect(commitResponseSchema.safeParse({
      commit: { hash: hash("c"), shortHash: "ccccccc", message: "Add second verse", parents: [hash("a")],
        createdAt: "2026-11-03T18:22:10Z", author: { id: "3f2b0c1e-8a4d-4c6b-9e1f-2a3b4c5d6e7f", username: "ryan" } },
      branch: { ...branch, headHash: hash("c"), created: false },
    }).success).toBe(true);
  });
  it("validates the STALE_PARENT error body", () => {
    expect(apiErrorBodySchema.safeParse({ error: { code: "STALE_PARENT", message: "Branch main has moved.",
      details: { branch: "main", headHash: hash("b"), yourParent: hash("9"), commitsAhead: 1 } } }).success).toBe(true);
  });
});

describe("error codes and roles", () => {
  it("map every plugin-handled code to the PDF's status", () => {
    expect(API_ERRORS).toMatchObject({ UNAUTHENTICATED: 401, TOKEN_EXPIRED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
      STALE_PARENT: 409, BRANCH_EXISTS: 409, BRANCH_ARCHIVED: 409, FILE_TOO_LARGE: 413, TOO_MANY_FILES: 413,
      NO_CHANGES: 422, VALIDATION_FAILED: 422, RATE_LIMITED: 429, UPGRADE_REQUIRED: 426 });
  });
  it("orders roles weakest to strongest", () => {
    expect(PROJECT_ROLES).toEqual(["viewer", "editor", "admin", "owner"]);
  });
});
