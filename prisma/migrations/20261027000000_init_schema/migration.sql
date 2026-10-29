-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "project_visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "project_role" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "file_format" AS ENUM ('MUSICXML', 'MXL', 'MSCZ', 'MSCX', 'OTHER');

-- CreateEnum
CREATE TYPE "pull_request_status" AS ENUM ('OPEN', 'MERGED', 'CLOSED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT,
    "bio" TEXT,
    "avatar_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "project_visibility" NOT NULL DEFAULT 'PRIVATE',
    "default_branch_id" UUID,
    "next_pull_request_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "project_role" NOT NULL,
    "invited_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id","user_id")
);

-- CreateTable
CREATE TABLE "blobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "format" "file_format" NOT NULL DEFAULT 'MUSICXML',
    "content_type" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "parsed_ast" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "score_metadata" (
    "blob_id" UUID NOT NULL,
    "title" TEXT,
    "subtitle" TEXT,
    "composer" TEXT,
    "arranger" TEXT,
    "lyricist" TEXT,
    "key_signature" TEXT,
    "time_signature" TEXT,
    "tempo_bpm" DECIMAL(6,2),
    "measure_count" INTEGER,
    "parts" JSONB,
    "parser_version" INTEGER NOT NULL,
    "extracted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "score_metadata_pkey" PRIMARY KEY ("blob_id")
);

-- CreateTable
CREATE TABLE "commits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "author_id" UUID,
    "message" TEXT NOT NULL,
    "ai_summary" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commit_parents" (
    "commit_id" UUID NOT NULL,
    "parent_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "commit_parents_pkey" PRIMARY KEY ("commit_id","position")
);

-- CreateTable
CREATE TABLE "commit_files" (
    "commit_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "blob_id" UUID NOT NULL,

    CONSTRAINT "commit_files_pkey" PRIMARY KEY ("commit_id","path")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "head_commit_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "commit_id" UUID NOT NULL,
    "message" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "pull_request_status" NOT NULL DEFAULT 'OPEN',
    "source_branch_id" UUID,
    "target_branch_id" UUID,
    "author_id" UUID,
    "merge_commit_id" UUID,
    "merged_by_id" UUID,
    "ai_conflict_notes" JSONB,
    "merged_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "projects_default_branch_id_key" ON "projects"("default_branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_owner_id_slug_key" ON "projects"("owner_id", "slug");

-- CreateIndex
CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "blobs_project_id_sha256_key" ON "blobs"("project_id", "sha256");

-- CreateIndex
CREATE INDEX "commits_project_id_created_at_idx" ON "commits"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "commits_author_id_idx" ON "commits"("author_id");

-- CreateIndex
CREATE INDEX "commit_parents_parent_id_idx" ON "commit_parents"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "commit_parents_commit_id_parent_id_key" ON "commit_parents"("commit_id", "parent_id");

-- CreateIndex
CREATE INDEX "commit_files_blob_id_idx" ON "commit_files"("blob_id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_project_id_name_key" ON "branches"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tags_project_id_name_key" ON "tags"("project_id", "name");

-- CreateIndex
CREATE INDEX "pull_requests_project_id_status_idx" ON "pull_requests"("project_id", "status");

-- CreateIndex
CREATE INDEX "pull_requests_source_branch_id_idx" ON "pull_requests"("source_branch_id");

-- CreateIndex
CREATE INDEX "pull_requests_target_branch_id_idx" ON "pull_requests"("target_branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_project_id_number_key" ON "pull_requests"("project_id", "number");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_branch_id_fkey" FOREIGN KEY ("default_branch_id") REFERENCES "branches"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_metadata" ADD CONSTRAINT "score_metadata_blob_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "blobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit_parents" ADD CONSTRAINT "commit_parents_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "commits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit_parents" ADD CONSTRAINT "commit_parents_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "commits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit_files" ADD CONSTRAINT "commit_files_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "commits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit_files" ADD CONSTRAINT "commit_files_blob_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "blobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_head_commit_id_fkey" FOREIGN KEY ("head_commit_id") REFERENCES "commits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "commits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_source_branch_id_fkey" FOREIGN KEY ("source_branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_target_branch_id_fkey" FOREIGN KEY ("target_branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_merge_commit_id_fkey" FOREIGN KEY ("merge_commit_id") REFERENCES "commits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_merged_by_id_fkey" FOREIGN KEY ("merged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Hand-written: constraints and indexes Prisma's schema language can't express ───

-- 25 MB per file, matching the Storage bucket's limit.
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_size_bytes_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 26214400);

-- Fast lookup of a project's active (non-archived) branches.
CREATE INDEX "idx_branches_project_active" ON "branches"("project_id") WHERE "archived_at" IS NULL;

-- ─── Hand-written: Row Level Security ───
-- Supabase exposes public tables through its Data API. RLS with no policies blocks that access;
-- the app connects through Prisma as the table owner, which RLS doesn't restrict.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "blobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "score_metadata" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commit_parents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commit_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pull_requests" ENABLE ROW LEVEL SECURITY;
