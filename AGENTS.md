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
| `prisma/migrations/` | Generated SQL migrations for app tables (none yet). |
| `supabase/migrations/` | Hand-written SQL for the `auth` schema, triggers, and RLS. |
| `src/lib/auth/` | Auth core: config, cookies, guards, rate limiting, routes, usernames. |
| `src/lib/supabase/` | Supabase server and proxy clients. |
| `src/app/api/auth/*`, `src/app/auth/confirm` | Auth route handlers (thin re-exports of `src/lib/auth/routes.ts`). |
| `src/proxy.ts` | Refreshes sessions on page requests. It does not authorize anything. |
| `src/generated/prisma/` | Generated Prisma client (gitignored). |
| `docs/` | `AUTH_API.md`, `ENVIRONMENT.md`, `DATABASE_SCHEMA.md` |
| `tests/` | `auth/` (Vitest), `smoke/` and `integration/` (Playwright) |

## Commands

`npm run dev` · `npm run build` · `npm run lint` · `npm run typecheck` · `npm test` · `npm run test:smoke` · `npm run test:integration` · `npx prisma validate` · `npx prisma generate` · `npx prisma studio`

Print the SQL for the current schema without a database: `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`

## Rules and gotchas

- Take ownership from the verified `user.id` (`withAuthenticatedRoute` / `requireUser`), never from request fields or usernames.
- Enable RLS on every new `public` table. Supabase exposes them through its API by default.
- Prisma can't manage anything in the `auth` schema (its shadow database has none). That goes in `supabase/migrations/`.
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

- **2026-10-22, `feat/db-schema` (Guy):** Added `ScoreControl_Backend_Status_2026-10-22.pdf` at the repo root, a 3-page meeting handout. It covers status, the 5 technical schema decisions, key and secret handling, RLS status, local Supabase onboarding, the frontend login checklist, and remaining login and schema work.
- **2026-10-21, `main` (Guy):** Merged PR #2 (`feat/db-schema` → `main`) before the 10/22 meeting, merged without review approval at Guy's call. The schema is in `main` but has no migration, so the database is unchanged. Meeting decisions get applied as follow-up PRs.
- **2026-10-21, `main` (Oliver van der Kouwe):** Merged PR #1 (`user-auth` → `main`) as merge commit `b9e34b0`, with no changes beyond the 5 reviewed auth commits. The flaky test is still unfixed. PR #2 (`feat/db-schema`) retargeted from `user-auth` to `main`; it applies with no conflicts and needs no rebase.
- **2026-10-21, `feat/db-schema` (Guy):** Reviewed `user-auth`: lint, typecheck, and build pass; 197/198 unit tests pass. The one failure is a timing flake in `tests/auth/supabase-sdk.test.ts:196`, which calls `session()` twice and so compares two tokens built across a second boundary. Drafted the app schema in `prisma/schema.prisma`: profiles, projects, project_members, blobs, score_metadata, commits, commit_parents, commit_files, branches, tags, pull_requests. Scenario checks on embedded Postgres caught two bugs, both fixed: ids and `updated_at` had no database default, and NO ACTION FKs made project deletion depend on cascade order. Wrote `docs/DATABASE_SCHEMA.md` and this log. No migration yet.
- **2026-10-20, `user-auth` (Oliver van der Kouwe):** Supabase cookie-session auth API (signup, login, logout, me, username, password reset/change, email confirm). Added a private `scorecontrol_auth.usernames` registry with a signup trigger and service-role RPCs, Upstash rate limiting, Vitest and Playwright suites, and `docs/AUTH_API.md` and `docs/ENVIRONMENT.md`. Not merged to `main` yet.
- **2026-10-15, `main` (Guy):** Scaffolded Next.js 16 with TypeScript, Tailwind, and ESLint. Added Supabase and Prisma 7 (pinned), the Prisma client generated on install, the Supabase CLI linked to the hosted project, the env template, Node engine versions, and README setup instructions.

## Next TODOs: schema follow-ups

PR #2 (`feat/db-schema`) is merged into `main`. Do the remaining work on a new branch off `main`.

- [ ] Apply the 10/22 meeting's answers to the technical questions (main format, LLM output storage, profile trigger, size limits, branch archiving) to `prisma/schema.prisma` and `docs/DATABASE_SCHEMA.md`.
- [ ] Delete the merged `feat/db-schema` and `user-auth` branches.
- [ ] Ask Oliver to fix the flaky test in `tests/auth/supabase-sdk.test.ts:196` (build the session once and reuse it).
- [ ] Apply the agreed changes to `prisma/schema.prisma`, then `npx prisma migrate dev --name init_schema`.
- [ ] Supabase migration: FK `profiles.id → auth.users(id) ON DELETE CASCADE`, a trigger creating the profile and copying the username from `scorecontrol_auth.usernames`, and `ENABLE ROW LEVEL SECURITY` on every new table.
- [ ] Create a private Supabase Storage bucket for blobs.
- [ ] Add a shared Prisma client in `src/lib/db.ts` using `@prisma/adapter-pg` and `DATABASE_URL`.
- [ ] Turn the embedded-Postgres scenario checks (branching, merge, PR, compare-and-swap, cascades) into a Vitest suite under `tests/db/`.
