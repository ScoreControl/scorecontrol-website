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
| File storage | Supabase Storage, private `blobs` bucket (25 MB) | Score file bytes, keyed `{projectId}/{sha256}`. |
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
| `src/lib/api/` | Project API core: `withApiRoute` (bearer or cookie auth, error envelope), `requireProjectRole`, `apiError` helpers, and `contract.ts`. |
| `src/lib/api/contract.ts` | Plugin/web API contract: zod schemas, types, error codes. Shared with the mock server; no server-only imports. Written version: `docs/api-contract.md`. |
| `src/lib/db.ts` | Shared Prisma client (`getDb()`). Bypasses RLS: scope every query by the verified user and role. |
| `src/lib/supabase/` | Supabase server and proxy clients. |
| `src/app/api/auth/*`, `src/app/auth/confirm` | Auth route handlers (thin re-exports of `src/lib/auth/routes.ts`). |
| `src/proxy.ts` | Refreshes sessions on page requests. It does not authorize anything. |
| `src/generated/prisma/` | Generated Prisma client (gitignored). |
| `docs/` | `api-contract.md`, `AUTH_API.md`, `ENVIRONMENT.md`, `DATABASE_SCHEMA.md`; meeting handouts (PDFs) in `docs/handouts/` |
| `tests/` | `api/`, `auth/`, and `db/` (Vitest), `smoke/` and `integration/` (Playwright) |

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

## Watch-outs (codebase scan, 2026-11-05)

Known risks and traps. Update or remove an item when it's resolved.

- **Hosted database is behind the code.** `users_sync_triggers`, `plugin_api`, and the `blobs` bucket migration exist only in git. Apply them (`npx supabase db push`, then `npx prisma migrate deploy`) before any route touches real tables.
- **Stacked branches.** `feat/api-contract` ← `feat/data-layer` ← `feat/api-core` ← `feat/plugin-auth`. Merge them in that order with merge commits. If one is squash-merged, rebase the rest onto `main` (`git rebase --onto main <old-parent> <branch>`) or they'll show duplicate commits.
- **Ryan's `ui/ui+auth`** merges cleanly with the stack (checked 11/05). Its only backend change is a blank line in `src/lib/auth/config.ts`.
- **Prisma bypasses RLS.** Every project query must start from `requireProjectRole(caller.id, ...)`. A route that queries by `projectId` without it leaks private projects.
- **Archived projects are invisible to `requireProjectRole`**, owners included. An unarchive route will need its own lookup.
- **Two login modes share `POST /api/auth/login`.** The origin check is skipped only when the body says `client: "plugin"`, and that mode must never set cookies. Don't add cookie writes to `pluginLogin`.
- **Bearer tokens are verified by calling Supabase** (`getUser(token)`, ~50-100 ms per request). Moving to asymmetric JWT keys plus `getClaims` makes it local, but then a logged-out token stays valid until it expires (about an hour).
- **Idempotency keys are scoped by user, not project.** The commit route must include the project id in `request_hash` so one key can't replay across projects.
- **`projects.slug` is required and unique per owner.** The create route must generate it and retry on a collision (`sonata-in-d-2`).
- **Commit hashes:** the server computes them from canonical JSON (`docs/api-contract.md` §2). Never accept a hash from the client, and keep `created_at` in the hash identical to the stored value (millisecond precision).
- **Request body limits:** `readJson` caps JSON at 8 KB (auth only). Multipart commits need their own streaming limit, and serverless hosts may cap bodies well below 25 MB (contract §11, "Large uploads").
- **Flaky test:** `tests/auth/supabase-sdk.test.ts:196` can fail across a second boundary. Re-run before assuming a real failure.

## Git workflow

- Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`. Slashes group branches like folders in GitHub and git tools. You can't have both `feat` and `feat/x` as branches.
- Merge through a PR, then delete the branch. The PR and its commits stay on GitHub, and a deleted branch can be restored from the PR page. Turn on GitHub's "Automatically delete head branches" setting.
- Git has no branch archive. To keep unmerged work you're shelving, tag it (`git tag archive/<name> <branch>`, then `git push origin archive/<name>`) and delete the branch.
- Commit messages: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`).

## Change log

Newest first.

- **2026-11-13, `feat/plugin-api` (Guy):** Added CI (`.github/workflows/ci.yml`: prisma validate, lint, typecheck, tests, build; no secrets, placeholder env for the build) and `tests/api/http.test.ts`, which drives every project route through its real route module (auth wrapper, multipart, catch-all, base64) on PGlite with only Supabase faked. Every commit on the branch passes the suite. 318/318 tests pass.
- **2026-11-13, `feat/plugin-api` (Guy):** Added `POST /api/projects/:id/commit-message-suggestions` (contract section 9) with a free rule-based writer (`src/lib/suggestions/`, model `scorecontrol/rules-v1`): a regex MusicXML outline (title, parts, measures) and a measure-level diff produce messages like "Edit bars 2–3 in Violin; add 1 measure". Compressed `.mxl`/`.mscz` get "Update <path>". No LLM yet (decision: free first; Claude Haiku 5.5 later behind `suggestCommitMessage`, falling back to the rules). Not done: per-user rate limit and daily cost cap (not needed until an LLM is added). 316/316 tests pass.
- **2026-11-13, `feat/plugin-api` (Guy):** Added `POST /api/projects/:id/commits` (contract section 7) in `src/lib/projects/commit.ts`: multipart snapshot, server-computed blob and commit hashes, branch row locked `FOR UPDATE`, `409 STALE_PARENT` with `commitsAhead`, `newBranch` forks, `422 NO_CHANGES`, and `Idempotency-Key` replay (24 h) stored in the same transaction. Blobs upload to Storage before the transaction (content-addressed, so a rollback only leaves unused bytes). Not done: background parsing into `parsed_ast` (no parser yet). Gotcha: `@prisma/adapter-pg` misreads `timestamptz` values with a non-UTC offset; Supabase runs in UTC, and the PGlite tests now pin UTC. Watch-out: Vercel caps request bodies at 4.5 MB, so large commits will need direct-to-Storage uploads before deploying there. 310/310 tests pass.
- **2026-11-13, `feat/plugin-api` (Guy):** One branch for the rest of the plugin API (contract sections 7–9), one commit per piece. So far: `src/lib/storage.ts` (secret-key client for the private `blobs` bucket), `GET /api/projects/:id/commits/:hash` (detail with files), and `GET /api/projects/:id/blobs/:sha256` (raw bytes, or JSON with `?encoding=base64`). 304/304 tests pass.
- **2026-11-13, `feat/history` (Guy):** Built `GET /api/projects/:id/branches/:name/commits` (contract section 8): newest first along first parents, `parents` lists every parent, opaque base64url cursor of the next commit's hash. It shares the `branches/[...name]` catch-all with PATCH: a trailing `commits` segment means history. 2 new tests; 302/302 pass.
- **2026-11-13, `feat/sync` (Guy):** Built `GET /api/projects/:id/sync` (contract section 6). Relation comes from two recursive CTEs over `commit_parents` (all parents, so merges count); `commitsAhead` = commits reachable from the head but not from the local commit; unknown hashes answer `unrelated`. Skipped the mock server (plugin developer not blocked). 3 new tests; 300/300 pass.
- **2026-11-12, `feat/project-routes` (Guy):** Built section 5 of `docs/api-contract.md`: `GET/POST /api/projects`, `GET /api/projects/:id`, `GET/POST /api/projects/:id/branches`, `PATCH /api/projects/:id/branches/:name` (catch-all route, since branch names can contain `/`). Logic in `src/lib/projects/service.ts`; slugs get `-2`, `-3` suffixes; `format` is accepted but not stored (projects have no format column). Added `tests/api/projects.test.ts` (8 tests on PGlite through `@prisma/adapter-pg`, via the pinned dev dependency `@electric-sql/pglite-socket`). Hosted database confirmed up to date (3 Prisma migrations). 297/297 tests pass. Gotcha: on Windows, run Vitest from `C:\...`; a lowercase `c:\` working directory makes every test file fail with "failed to find the current suite".
- **2026-11-12, `main` (Guy):** Merged PR #4 (`feat/plugin-auth`, including `feat/api-contract`, `feat/data-layer`, `feat/api-core`), PR #5 (Ryan's `ui/ui+auth`), and `feat/google-sign-in`. Resolved the AGENTS.md conflicts by keeping both change logs and combining the TODO lists.
- **2026-11-05, `feat/plugin-auth` (Guy):** Step 4. `POST /api/auth/login` with `client: "plugin"` returns `{ accessToken, refreshToken, expiresAt, user }` through an in-memory Supabase client (no cookies; origin check skipped only for plugin bodies, still checked first for web logins). New `POST /api/auth/refresh` (rotating refresh tokens, `refresh` rate limit 60/5 min). `readJson` takes `{ checkOrigin: false }` for token routes. 283/283 tests pass.
- **2026-11-05, `feat/api-core` (Guy):** Step 3. `withApiRoute` accepts `Authorization: Bearer` (verified with Supabase `getUser(token)`, no cookies, no origin check, `TOKEN_EXPIRED` read from `exp` before any network call) or falls back to `withAuthenticatedRoute` for cookies. `requireProjectRole` returns 404 for non-members and missing or malformed ids, 403 for low roles. `getIdentity` takes an optional access token. 276/276 tests pass.
- **2026-11-05, `feat/data-layer` (Guy):** Step 2 of the plugin plan. Migration `20261105000000_plugin_api`: `commits.hash` (lowercase hex, unique per project), `commit_files.role` (`file_role` enum, default `PRIMARY`), `idempotency_keys` (RLS on), and a `branches_name_check` matching the contract. Supabase migration `20261105000000_blobs_bucket` creates the private 25 MB `blobs` bucket. Added `src/lib/db.ts`. 248/248 tests pass. Not applied to the hosted project yet.
- **2026-11-05, `feat/api-contract` (Guy):** Step 1 of the Nov 2–6 plugin plan. Added `docs/api-contract.md` (the plan's sections 3–8 with the 11/05 decisions: commits get a `hash` column beside the UUID, 100 files counted per snapshot, Claude Haiku for suggestions, MusicXML as the single primary file) and `src/lib/api/contract.ts` with `tests/api/contract.test.ts`. Error responses can now carry `details` next to `fields` (`AuthHttpError` gained a `details` argument). 242/242 tests pass.
- **2026-10-30, `feat/google-sign-in` (Guy):** Added `ScoreControl_Backend_Progress_2026-10-30.pdf` at the repo root, a 4-page progress update and next week's plan (Nov 2 to 6): live database, 10/22 schema decisions, Google sign-in and login status, then a 10-item plan with owners covering Google sign-in, login fixes, the Storage bucket and database client, project API routes, project UI, logout and reset pages, CI, the diff engine handoff, LLM commit messages, and a shared test site.
- **2026-10-29, `feat/google-sign-in` (Guy):** Added Google sign-in. `GET /api/auth/oauth/google` starts the PKCE flow through Supabase and redirects to Google; the existing `/auth/confirm` finishes it. New Google users have no username until they claim one, and the `users` trigger then creates their row. Added `tests/auth/oauth.test.ts` (6 tests), a disabled `[auth.external.google]` block in `supabase/config.toml` for local testing, and setup steps in `docs/ENVIRONMENT.md` and `docs/AUTH_API.md`. The login/signup button goes on Ryan's pages (`ui/ui+auth`).
- **2026-10-29, hosted Supabase (Guy):** Confirmed Oliver's username migration was already applied (`supabase db push --dry-run`: up to date). Ran `npx prisma migrate deploy` on the hosted project: both migrations applied, 11 app tables with RLS, and both `users` triggers installed.
- **2026-10-27, `feat/init-schema` (Guy):** Applied the team's 10/22 schema decisions:
    - `profiles` renamed to `users`.
    - `blobs` gained `storage_path`, `parsed_ast` (JSONB), and an `INTEGER` `size_bytes` capped at 25 MB; `format` defaults to `MUSICXML` and keeps `OTHER`.
    - `commits.ai_summary`, `pull_requests.ai_conflict_notes`, and `branches.archived_at` with a partial index.
    - First migrations: `init_schema` (tables, CHECK, index, RLS on every table) and `users_sync_triggers` (`on_username_created` creates users rows; deleting an auth account deletes its row).
    - No FK from `users` to `auth.users`, because Prisma fails on cross-schema FKs (P4002). The triggers were first a Supabase migration, but `supabase start` applies those before Prisma creates `users`, so they moved into a guarded Prisma migration.
    - Added `tests/db/schema.test.ts` (10 tests). Verified on Postgres 17: migrations apply, no Prisma drift, and the migration fails clearly if the username registry is missing. 208/208 tests pass.
- **2026-10-22, `feat/db-schema` (Guy):** Added `ScoreControl_Backend_Status_2026-10-22.pdf` (now in `docs/handouts/`), a 3-page meeting handout. It covers status, the 5 technical schema decisions, key and secret handling, RLS status, local Supabase onboarding, the frontend login checklist, and remaining login and schema work.
- **2026-10-21, `main` (Guy):** Merged PR #2 (`feat/db-schema` → `main`) before the 10/22 meeting, merged without review approval at Guy's call. The schema is in `main` but has no migration, so the database is unchanged. Meeting decisions get applied as follow-up PRs.
- **2026-10-21, `main` (Oliver van der Kouwe):** Merged PR #1 (`user-auth` → `main`) as merge commit `b9e34b0`, with no changes beyond the 5 reviewed auth commits. The flaky test is still unfixed. PR #2 (`feat/db-schema`) retargeted from `user-auth` to `main`; it applies with no conflicts and needs no rebase.
- **2026-10-21, `feat/db-schema` (Guy):** Reviewed `user-auth`: lint, typecheck, and build pass; 197/198 unit tests pass. The one failure is a timing flake in `tests/auth/supabase-sdk.test.ts:196`, which calls `session()` twice and so compares two tokens built across a second boundary. Drafted the app schema in `prisma/schema.prisma`: profiles, projects, project_members, blobs, score_metadata, commits, commit_parents, commit_files, branches, tags, pull_requests. Scenario checks on embedded Postgres caught two bugs, both fixed: ids and `updated_at` had no database default, and NO ACTION FKs made project deletion depend on cascade order. Wrote `docs/DATABASE_SCHEMA.md` and this log. No migration yet.
- **2026-10-20, `user-auth` (Oliver van der Kouwe):** Supabase cookie-session auth API (signup, login, logout, me, username, password reset/change, email confirm). Added a private `scorecontrol_auth.usernames` registry with a signup trigger and service-role RPCs, Upstash rate limiting, Vitest and Playwright suites, and `docs/AUTH_API.md` and `docs/ENVIRONMENT.md`. Not merged to `main` yet.
- **2026-10-15, `main` (Guy):** Scaffolded Next.js 16 with TypeScript, Tailwind, and ESLint. Added Supabase and Prisma 7 (pinned), the Prisma client generated on install, the Supabase CLI linked to the hosted project, the env template, Node engine versions, and README setup instructions.

## Current branch TODOs: `main`

- [ ] Review `docs/api-contract.md` with the plugin developer and Ryan; open the PR.
- [ ] Apply to the hosted project: `npx supabase db push --linked` (the `20261105000000_blobs_bucket` migration is already applied), then `npx prisma migrate deploy` (applies `20261105000000_plugin_api`; init migrations were applied 2026-10-29).
- [ ] Optional: switch the hosted project to asymmetric JWT signing keys, then verify bearer tokens locally with `getClaims`.
- [x] Project and branch routes (contract section 5).
- [x] Sync route (contract section 6).
- [x] History, commit detail, and blob download routes (contract section 8).
- [x] Commit route with concurrency test (contract section 7).
- [x] Commit message suggestions, rule-based (contract section 9).
- [x] CI and end-to-end route tests.
- [ ] Next steps (plan order): PR for `feat/plugin-api` → optional LLM suggestions (Claude Haiku 5.5, needs an API key).
- [ ] Guy: create the Google OAuth client (redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`) and enable Google in Supabase → Authentication → Sign In / Providers.
- [ ] Guy: add `http://localhost:3000/auth/confirm` to Supabase → Authentication → URL Configuration → Redirect URLs.
- [ ] Ryan: add `<a href="/api/auth/oauth/google">Continue with Google</a>` to the login and signup pages, and a username form for accounts where `/api/auth/me` returns `username: null`.

## Backlog

- [ ] Delete the merged `user-auth` and `setup` branches (ask first).
- [ ] Archive Ryan's superseded `ui/ux-designs` branch (ask Ryan).
- [ ] Ask Oliver to fix the flaky test in `tests/auth/supabase-sdk.test.ts:196`.
- [ ] Custom SMTP before launch (Resend free tier needs a verified domain).
- [ ] Project/upload/commit/history/branch API routes (100 files per project).
