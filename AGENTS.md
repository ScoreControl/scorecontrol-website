<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# ScoreControl website

User-facing app for ScoreControl, version control ("git") for sheet music. Musicians create projects, commit score versions, branch, merge, and open pull requests. This team owns the backend and the LLM features. The diff/merge algorithm is built separately and plugs in behind the backend.

Keep this file current: update the change log and the branch TODOs with every change to the repo. Write only below the `END:nextjs-agent-rules` marker; `next dev` rewrites everything between the markers.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16.4 (App Router), React 19.3, TypeScript | `middleware.ts` is now `proxy.ts`. Read `node_modules/next/dist/docs/` before writing Next code. |
| Styling | Tailwind CSS 4 | |
| Auth | Supabase Auth via `@supabase/ssr` | HttpOnly cookie sessions handled by the server. See `docs/AUTH_API.md`. |
| Database | Supabase Postgres, Prisma 7.10 (`prisma-client` generator, `@prisma/adapter-pg`) | Do not install `prisma@latest` (it's a v8 pre-release). |
| File storage | Supabase Storage (planned) | Score file bytes, keyed `{projectId}/{sha256}`. |
| Rate limiting | Upstash Redis (`@upstash/ratelimit`) | Required in production, in-memory locally. |
| Validation | Zod 4 | |
| Tests | Vitest 4 (unit, migrations on PGlite), Playwright 1.64 (smoke, integration) | |
| Runtime | Node `^20.19 \|\| ^22.12 \|\| >=24` | |

## Where things live

| Path | What |
|---|---|
| `prisma/schema.prisma` | App tables (source of truth). Explained in `docs/DATABASE_SCHEMA.md`. |
| `prisma/migrations/` | App table migrations: `init_schema` (tables, 25 MB check, active-branch index, RLS) and `users_sync_triggers` (users rows from the username registry). Apply after `supabase/migrations/`. |
| `supabase/migrations/` | Hand-written SQL for the `auth` schema, triggers, and RLS. |
| `src/lib/auth/` | Auth core: config, cookies, guards, rate limiting, routes, usernames. |
| `src/lib/supabase/` | Supabase server and proxy clients. |
| `src/app/api/auth/*`, `src/app/auth/confirm` | Auth route handlers (thin re-exports of `src/lib/auth/routes.ts`). |
| `src/proxy.ts` | Refreshes sessions on page requests. It does not authorize anything. |
| `src/generated/prisma/` | Generated Prisma client (gitignored). |
| `docs/` | `AUTH_API.md`, `ENVIRONMENT.md`, `DATABASE_SCHEMA.md` |
| `tests/` | `auth/` and `db/` (Vitest), `smoke/` and `integration/` (Playwright) |

## Commands

`npm run dev` · `npm run build` · `npm run lint` · `npm run typecheck` · `npm test` · `npm run test:smoke` · `npm run test:integration` · `npx prisma validate` · `npx prisma generate` · `npx prisma studio`

Print the SQL for the current schema without a database: `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`

## Rules and gotchas

- Take ownership from the verified `user.id` (`withAuthenticatedRoute` / `requireUser`), never from request fields or usernames.
- Enable RLS on every new `public` table. Supabase exposes them through its API by default.
- Prisma can't manage anything in the `auth` schema (its shadow database has none). That goes in `supabase/migrations/`, or in a Prisma migration guarded by `to_regnamespace('auth')` like `users_sync_triggers`.
- No foreign keys from `public` tables into `auth`: Prisma fails to introspect them (P4002). Use triggers instead.
- Migration order: `supabase/migrations/` first, then `npx prisma migrate deploy`.
- Give generated ids and `updated_at` a database default (`dbgenerated("gen_random_uuid()")`, `@default(now())`) so plain SQL inserts work. Prisma's `uuid()` and `@updatedAt` only run inside the Prisma client.
- Never run `supabase config push`. `prisma migrate reset` deletes the auth RPCs in `public`, so re-apply the Supabase migration afterwards.
- Never commit `.env.local`. The free-tier Supabase project pauses after about a week idle.
- WSL: Playwright needs `sudo npx playwright install-deps` once, or Chromium fails with `libnspr4.so` missing.

## Git workflow

- Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`. Slashes group branches like folders in GitHub and git tools. You can't have both `feat` and `feat/x` as branches.
- Merge through a PR, then delete the branch. The PR and its commits stay on GitHub, and a deleted branch can be restored from the PR page. Turn on GitHub's "Automatically delete head branches" setting.
- Git has no branch archive. To keep unmerged work you're shelving, tag it (`git tag archive/<name> <branch>`, then `git push origin archive/<name>`) and delete the branch.
- Commit messages: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`).

## Change log

Newest first.

- **2026-10-30, `feat/google-sign-in` (Guy):** Added `ScoreControl_Backend_Progress_2026-10-30.pdf` at the repo root, a 2-page progress update: live database, 10/22 schema decisions, Google sign-in status, login/frontend status, and next steps.
- **2026-10-29, `feat/google-sign-in` (Guy):** Added Google sign-in. `GET /api/auth/oauth/google` starts the PKCE flow through Supabase and redirects to Google; the existing `/auth/confirm` finishes it. New Google users have no username until they claim one, and the `users` trigger then creates their row. Added `tests/auth/oauth.test.ts` (6 tests), a disabled `[auth.external.google]` block in `supabase/config.toml` for local testing, and setup steps in `docs/ENVIRONMENT.md` and `docs/AUTH_API.md`. The login/signup button goes on Ryan's pages (`ui/ui+auth`).
- **2026-10-29, hosted Supabase (Guy):** Confirmed Oliver's username migration was already applied (`supabase db push --dry-run`: up to date). Ran `npx prisma migrate deploy` on the hosted project: both migrations applied, 11 app tables with RLS, and both `users` triggers installed.
- **2026-10-27, `feat/init-schema` (Guy):** Applied the team's 10/22 schema decisions:
    - `profiles` renamed to `users`.
    - `blobs` gained `storage_path`, `parsed_ast` (JSONB), and an `INTEGER` `size_bytes` capped at 25 MB; `format` defaults to `MUSICXML` and keeps `OTHER`.
    - `commits.ai_summary`, `pull_requests.ai_conflict_notes`, and `branches.archived_at` with a partial index.
    - First migrations: `init_schema` (tables, CHECK, index, RLS on every table) and `users_sync_triggers` (`on_username_created` creates users rows; deleting an auth account deletes its row).
    - No FK from `users` to `auth.users`, because Prisma fails on cross-schema FKs (P4002). The triggers were first a Supabase migration, but `supabase start` applies those before Prisma creates `users`, so they moved into a guarded Prisma migration.
    - Added `tests/db/schema.test.ts` (10 tests). Verified on Postgres 17: migrations apply, no Prisma drift, and the migration fails clearly if the username registry is missing. 208/208 tests pass.
- **2026-10-22, `feat/db-schema` (Guy):** Added `ScoreControl_Backend_Status_2026-10-22.pdf` at the repo root, a 3-page meeting handout. It covers status, the 5 technical schema decisions, key and secret handling, RLS status, local Supabase onboarding, the frontend login checklist, and remaining login and schema work.
- **2026-10-21, `main` (Guy):** Merged PR #2 (`feat/db-schema` → `main`) before the 10/22 meeting, merged without review approval at Guy's call. The schema is in `main` but has no migration, so the database is unchanged. Meeting decisions get applied as follow-up PRs.
- **2026-10-21, `main` (Oliver van der Kouwe):** Merged PR #1 (`user-auth` → `main`) as merge commit `b9e34b0`, with no changes beyond the 5 reviewed auth commits. The flaky test is still unfixed. PR #2 (`feat/db-schema`) retargeted from `user-auth` to `main`; it applies with no conflicts and needs no rebase.
- **2026-10-21, `feat/db-schema` (Guy):** Reviewed `user-auth`: lint, typecheck, and build pass; 197/198 unit tests pass. The one failure is a timing flake in `tests/auth/supabase-sdk.test.ts:196`, which calls `session()` twice and so compares two tokens built across a second boundary. Drafted the app schema in `prisma/schema.prisma`: profiles, projects, project_members, blobs, score_metadata, commits, commit_parents, commit_files, branches, tags, pull_requests. Scenario checks on embedded Postgres caught two bugs, both fixed: ids and `updated_at` had no database default, and NO ACTION FKs made project deletion depend on cascade order. Wrote `docs/DATABASE_SCHEMA.md` and this log. No migration yet.
- **2026-10-20, `user-auth` (Oliver van der Kouwe):** Supabase cookie-session auth API (signup, login, logout, me, username, password reset/change, email confirm). Added a private `scorecontrol_auth.usernames` registry with a signup trigger and service-role RPCs, Upstash rate limiting, Vitest and Playwright suites, and `docs/AUTH_API.md` and `docs/ENVIRONMENT.md`. Not merged to `main` yet.
- **2026-10-15, `main` (Guy):** Scaffolded Next.js 16 with TypeScript, Tailwind, and ESLint. Added Supabase and Prisma 7 (pinned), the Prisma client generated on install, the Supabase CLI linked to the hosted project, the env template, Node engine versions, and README setup instructions.

## Current branch TODOs: `feat/google-sign-in`

- [x] Start route, tests, local config, and docs for Google sign-in.
- [ ] Guy: create the Google OAuth client (redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`) and enable Google in Supabase → Authentication → Sign In / Providers.
- [ ] Guy: add `http://localhost:3000/auth/confirm` to Supabase → Authentication → URL Configuration → Redirect URLs.
- [ ] Ryan: add `<a href="/api/auth/oauth/google">Continue with Google</a>` to the login and signup pages, and a username form for accounts where `/api/auth/me` returns `username: null`.
- [ ] Open a PR for `feat/google-sign-in` → `main`.

## Backlog

- [ ] Ryan's 4 fixes on `ui/ui+auth` (lint, `data.data.status`, show API errors, `getCurrentUser()`), then his PR.
- [ ] Delete the merged `user-auth` and `setup` branches (ask first).
- [ ] Ask Oliver to fix the flaky test in `tests/auth/supabase-sdk.test.ts:196`.
- [ ] Custom SMTP before launch (Resend free tier needs a verified domain).
- [ ] Private Storage bucket for blobs (25 MB limit), shared Prisma client in `src/lib/db.ts`, then project/upload/commit/history/branch API routes (100 files per project).
