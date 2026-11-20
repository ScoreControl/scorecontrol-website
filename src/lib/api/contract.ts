/**
 * Plugin and web API contract: request/response shapes and error codes for /api/projects/*,
 * plus the plugin additions to /api/auth/*. The written version is docs/api-contract.md.
 *
 * Shared by the route handlers, the mock server, and tests, so it must stay free of
 * server-only imports. Change it only together with docs/api-contract.md.
 */
import { z } from "zod";

// ─── Limits and identifiers ────────────────────────────────────────────────

/** 25 MB, matching the blobs CHECK constraint and the Storage bucket limit. */
export const MAX_FILE_BYTES = 26_214_400;
/** Distinct paths in one commit's snapshot. */
export const MAX_FILES_PER_COMMIT = 100;
export const MAX_MESSAGE_LENGTH = 5000;
export const SHORT_HASH_LENGTH = 7;
export const DEFAULT_BRANCH = "main";

export const fullHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "Use a 64-character lowercase hex hash.");
/** A full hash or a unique prefix of at least 7 characters. */
export const hashRefSchema = z.string().trim().toLowerCase()
  .regex(/^[0-9a-f]{7,64}$/, "Use a commit hash or a prefix of at least 7 hex characters.");
export const projectIdSchema = z.uuid();

/**
 * 1 to 64 letters, digits, ".", "_", "-", "/". Also rejects names git would refuse, so branches
 * can be mirrored to git later: no leading "/" or ".", no trailing "/", no "..", "//", or ".lock" suffix.
 */
export const branchNameSchema = z.string().min(1).max(64)
  .regex(/^[A-Za-z0-9._/-]+$/, "Use letters, digits, '.', '_', '-', and '/'.")
  .refine((name) => !/^[/.]|\/$|\.\.|\/\/|\.lock$/.test(name),
    "Branch names can't start with '/' or '.', end with '/' or '.lock', or contain '..' or '//'.");

export const fileFormatSchema = z.enum(["MUSICXML", "MXL", "MSCZ", "MSCX", "OTHER"]);
/** primary: the score the diff engine and LLM read. native: optional MuseScore file for exact restores. */
export const fileRoleSchema = z.enum(["primary", "native", "attachment"]);
export const projectRoleSchema = z.enum(["viewer", "editor", "admin", "owner"]);
/** Ordered weakest to strongest; requireProjectRole compares positions. */
export const PROJECT_ROLES = projectRoleSchema.options;

/** Project-relative path: no leading "/", no "." or ".." segments, no backslashes. */
export const filePathSchema = z.string().min(1).max(512)
  .refine((path) => !path.startsWith("/") && !path.includes("\\") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  "Use a relative path like 'parts/violin.musicxml'.");

// ─── Requests ──────────────────────────────────────────────────────────────

export const createProjectRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  format: fileFormatSchema.default("MUSICXML"),
  description: z.string().trim().max(2000).optional(),
});

/** PATCH /api/projects/:id (admin+). The slug stays fixed so plugin links keep working. */
export const updateProjectRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
}).refine((value) => value.name !== undefined || value.description !== undefined, "Send name or description.");

/** Roles a member row can hold; the owner is not a member. */
export const memberRoleSchema = z.enum(["viewer", "editor", "admin"]);
/** POST /api/projects/:id/members */
export const addMemberRequestSchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(1).max(39),
  role: memberRoleSchema,
});
/** PATCH /api/projects/:id/members/:userId */
export const updateMemberRequestSchema = z.strictObject({ role: memberRoleSchema });

export const createBranchRequestSchema = z.strictObject({ name: branchNameSchema, fromHash: hashRefSchema });
export const updateBranchRequestSchema = z.strictObject({ archived: z.boolean() });

export const syncQuerySchema = z.object({
  branch: branchNameSchema.default(DEFAULT_BRANCH),
  /** The commit recorded in the open score; omit for a score that was never committed. */
  commit: hashRefSchema.optional(),
  includeArchived: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
});

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

export const blobQuerySchema = z.object({ encoding: z.enum(["binary", "base64"]).default("binary") });

/** One file part in a multipart commit or suggestion request. `field` names the form part holding the bytes. */
export const fileEntrySchema = z.strictObject({
  field: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  path: filePathSchema,
  format: fileFormatSchema.default("MUSICXML"),
  role: fileRoleSchema.default("primary"),
});

const uniqueFiles = (files: { field: string; path: string; role: string }[], context: z.RefinementCtx) => {
  const check = (key: "field" | "path", message: string) => {
    if (new Set(files.map((file) => file[key])).size !== files.length) context.addIssue({ code: "custom", path: ["files"], message });
  };
  check("field", "Each file needs its own form field.");
  check("path", "Each path can appear only once.");
  if (files.filter((file) => file.role === "primary").length !== 1) {
    context.addIssue({ code: "custom", path: ["files"], message: "Mark exactly one file as primary." });
  }
};

/** The JSON `metadata` part of POST /api/projects/:id/commits. */
export const commitMetadataSchema = z.strictObject({
  branch: branchNameSchema,
  /** The commit the edit started from; null only for a project's first commit. */
  parentHash: hashRefSchema.nullable(),
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  /** Set to fork: the server creates this branch at parentHash and commits onto it, atomically. */
  newBranch: z.strictObject({ name: branchNameSchema }).nullable().default(null),
  /** The optional LLM `summary`, stored as commits.ai_summary. */
  aiSummary: z.string().trim().max(MAX_MESSAGE_LENGTH).optional(),
  files: z.array(fileEntrySchema).min(1).max(MAX_FILES_PER_COMMIT),
}).superRefine((value, context) => uniqueFiles(value.files, context));

/** The JSON `metadata` part of POST /api/projects/:id/commit-message-suggestions. */
export const suggestionMetadataSchema = z.strictObject({
  branch: branchNameSchema,
  parentHash: hashRefSchema.nullable(),
  files: z.array(fileEntrySchema).min(1).max(MAX_FILES_PER_COMMIT),
}).superRefine((value, context) => uniqueFiles(value.files, context));

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "Use 8 to 128 letters, digits, '_' or '-'.");
/** Value of the X-Client header, e.g. "scorecontrol-plugin/0.3.1". */
export const clientHeaderSchema = z.string().regex(/^scorecontrol-plugin\/\d+\.\d+\.\d+$/);

/** Body of POST /api/auth/refresh. */
export const refreshRequestSchema = z.strictObject({ refreshToken: z.string().min(1).max(2048) });

// ─── Responses ─────────────────────────────────────────────────────────────

export const memberSchema = z.object({
  user: z.object({ id: z.uuid(), username: z.string() }),
  role: memberRoleSchema,
  createdAt: z.iso.datetime(),
});
/** GET /api/projects/:id/members */
export const listMembersResponseSchema = z.object({
  owner: z.object({ id: z.uuid(), username: z.string() }),
  members: z.array(memberSchema),
});
/** POST and PATCH member routes */
export const memberResponseSchema = z.object({ member: memberSchema });

export const authorSchema = z.object({ id: z.uuid(), username: z.string().nullable() });

export const commitSummarySchema = z.object({
  hash: fullHashSchema,
  shortHash: z.string().length(SHORT_HASH_LENGTH),
  message: z.string(),
  parents: z.array(fullHashSchema),
  createdAt: z.iso.datetime(),
  /** Null after the author deletes their account. */
  author: authorSchema.nullable(),
});

export const commitFileSchema = z.object({
  path: z.string(),
  format: fileFormatSchema,
  role: fileRoleSchema,
  sha256: fullHashSchema,
  size: z.number().int().positive(),
});

export const commitDetailSchema = commitSummarySchema.extend({
  aiSummary: z.string().nullable(),
  files: z.array(commitFileSchema),
});

export const branchSchema = z.object({
  name: z.string(),
  headHash: fullHashSchema.nullable(),
  headMessage: z.string().nullable(),
  archived: z.boolean(),
});

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  role: projectRoleSchema,
  defaultBranch: z.string(),
  createdAt: z.iso.datetime(),
});

/** POST /api/projects (201) */
export const createProjectResponseSchema = z.object({
  project: projectSchema,
  branch: branchSchema,
});

/** GET /api/projects */
export const listProjectsResponseSchema = z.object({
  projects: z.array(projectSchema.extend({ head: branchSchema })),
});

/** GET /api/projects/:id */
export const getProjectResponseSchema = z.object({
  project: projectSchema,
  branches: z.array(branchSchema),
});

/** GET /api/projects/:id/branches, and the list inside sync */
export const listBranchesResponseSchema = z.object({ branches: z.array(branchSchema) });

/** POST /api/projects/:id/branches (201) and PATCH .../branches/:name */
export const branchResponseSchema = z.object({ branch: branchSchema });

/**
 * same: the local commit is the branch head. behind: it is an ancestor of the head.
 * unrelated: it isn't in this branch's history. empty: the branch has no commits.
 * none: no local commit was sent (a score that was never committed).
 */
export const syncRelationSchema = z.enum(["same", "behind", "unrelated", "empty", "none"]);

/** GET /api/projects/:id/sync */
export const syncResponseSchema = z.object({
  branch: branchSchema,
  relation: syncRelationSchema,
  /** Commits on the branch after the local commit; 0 unless relation is "behind". */
  commitsAhead: z.number().int().nonnegative(),
  branches: z.array(branchSchema),
  role: projectRoleSchema,
});

/** GET /api/projects/:id/branches/:name/commits */
export const historyResponseSchema = z.object({
  commits: z.array(commitSummarySchema),
  /** Opaque; pass back as ?cursor= for the next page. Null on the last page. */
  nextCursor: z.string().nullable(),
});

/** GET /api/projects/:id/commits/:hash */
export const commitDetailResponseSchema = z.object({ commit: commitDetailSchema });

/** GET /api/projects/:id/blobs/:sha256?encoding=base64 */
export const blobBase64ResponseSchema = z.object({
  sha256: fullHashSchema,
  size: z.number().int().positive(),
  contentType: z.string(),
  base64: z.string(),
});

/** POST /api/projects/:id/commits (201, or the original 201 on an Idempotency-Key replay) */
export const commitResponseSchema = z.object({
  commit: commitSummarySchema,
  branch: branchSchema.extend({ created: z.boolean() }),
});

export const suggestionBasisSchema = z.enum(["structural_diff", "simple_diff", "initial_commit"]);

/** POST /api/projects/:id/commit-message-suggestions */
export const suggestionResponseSchema = z.object({
  suggestion: z.string(),
  summary: z.string().nullable(),
  model: z.string(),
  basis: suggestionBasisSchema,
});

/** POST /api/auth/login with client "plugin", and POST /api/auth/refresh */
export const pluginTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Unix seconds. */
  expiresAt: z.number().int(),
});

// ─── Errors ────────────────────────────────────────────────────────────────

/** Every code the project API returns, with its HTTP status. Clients branch on `code`, never on `message`. */
export const API_ERRORS = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  ORIGIN_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  AMBIGUOUS_HASH: 409,
  STALE_PARENT: 409,
  BRANCH_EXISTS: 409,
  BRANCH_ARCHIVED: 409,
  MEMBER_EXISTS: 409,
  IDEMPOTENCY_CONFLICT: 409,
  FILE_TOO_LARGE: 413,
  TOO_MANY_FILES: 413,
  REQUEST_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  NO_CHANGES: 422,
  VALIDATION_FAILED: 422,
  UPGRADE_REQUIRED: 426,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const satisfies Record<string, number>;
export type ApiErrorCode = keyof typeof API_ERRORS;

/** details of a 409 STALE_PARENT: enough for the plugin to warn and offer the new-branch flow. */
export const staleParentDetailsSchema = z.object({
  branch: z.string(),
  headHash: fullHashSchema.nullable(),
  headMessage: z.string().nullable(),
  yourParent: z.string().nullable(),
  commitsAhead: z.number().int().nonnegative().nullable(),
});

export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Machine-readable context, e.g. staleParentDetailsSchema for STALE_PARENT. */
    details: z.record(z.string(), z.unknown()).optional(),
    /** Field-level validation messages (kept for the web app's auth forms). */
    fields: z.record(z.string(), z.array(z.string())).optional(),
    /** Present on 5xx responses; quote it when reporting a problem. */
    requestId: z.string().optional(),
  }),
});

// ─── Types ─────────────────────────────────────────────────────────────────

export type ApiSuccess<T> = { data: T };
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
export type ProjectRole = z.infer<typeof projectRoleSchema>;
export type FileFormat = z.infer<typeof fileFormatSchema>;
export type FileRole = z.infer<typeof fileRoleSchema>;
export type CreateProjectRequest = z.input<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.input<typeof updateProjectRequestSchema>;
export type AddMemberRequest = z.input<typeof addMemberRequestSchema>;
export type MemberRole = z.infer<typeof memberRoleSchema>;
export type Member = z.infer<typeof memberSchema>;
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;
export type CreateBranchRequest = z.input<typeof createBranchRequestSchema>;
export type UpdateBranchRequest = z.input<typeof updateBranchRequestSchema>;
export type CommitMetadata = z.input<typeof commitMetadataSchema>;
export type SuggestionMetadata = z.input<typeof suggestionMetadataSchema>;
export type Branch = z.infer<typeof branchSchema>;
export type Project = z.infer<typeof projectSchema>;
export type CommitSummary = z.infer<typeof commitSummarySchema>;
export type CommitDetail = z.infer<typeof commitDetailSchema>;
export type CommitFile = z.infer<typeof commitFileSchema>;
export type SyncRelation = z.infer<typeof syncRelationSchema>;
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;
export type GetProjectResponse = z.infer<typeof getProjectResponseSchema>;
export type ListBranchesResponse = z.infer<typeof listBranchesResponseSchema>;
export type BranchResponse = z.infer<typeof branchResponseSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
export type CommitDetailResponse = z.infer<typeof commitDetailResponseSchema>;
export type BlobBase64Response = z.infer<typeof blobBase64ResponseSchema>;
export type CommitResponse = z.infer<typeof commitResponseSchema>;
export type SuggestionResponse = z.infer<typeof suggestionResponseSchema>;
export type PluginTokens = z.infer<typeof pluginTokensSchema>;
export type StaleParentDetails = z.infer<typeof staleParentDetailsSchema>;
