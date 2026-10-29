# scorecontrol-website
User-facing application for ScoreControl - Git For Sheet Music

## Tech stack

- [Next.js 16](https://nextjs.org/docs) (App Router) with React 19 and TypeScript
- [Tailwind CSS 4](https://tailwindcss.com/docs)
- [Supabase](https://supabase.com/docs): hosted Postgres and Auth
- [Prisma 7](https://www.prisma.io/docs) for app tables and migrations

## Getting started

Requires Node.js 20.19+ (24 recommended).

1. Install dependencies (this also generates the Prisma client into `src/generated/prisma`):
   ```bash
   npm install
   ```
2. Create your env file and fill in the values (ask Guy for them):
   ```bash
   cp .env.example .env.local
   ```
   Never commit `.env.local`.
3. Start the dev server and open http://localhost:3000:
   ```bash
   npm run dev
   ```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Generate Next.js types and check TypeScript |
| `npm test` | Run unit and migration tests |
| `npm run test:smoke` | Browser tests against a simulated auth provider (run `npx playwright install chromium` first) |
| `npm run test:integration` | Browser tests against a local Supabase instance |
| `npx prisma generate` | Regenerate the Prisma client after editing `prisma/schema.prisma` |
| `npx prisma studio` | Browse the database in a local UI |

## Database and migrations

There are two migration folders, each with its own job:

- **`prisma/`**: the app's own tables in the `public` schema (users, projects, commits, ...). Edit `prisma/schema.prisma`, then run `npx prisma migrate dev --name <change>`.
- **`supabase/migrations/`**: SQL that touches Supabase's `auth` schema (e.g. the trigger that creates a profile on sign-up) and Row Level Security. Prisma can't manage these because its shadow database has no `auth` schema. Create one with `npx supabase migration new <name>` and apply it with `npx supabase db push` (run `npx supabase link --project-ref <ref>` once first).

Prisma CLI config lives in `prisma7.config.ts`, and migrations use `DIRECT_URL`.

**Order:** apply Supabase migrations first (`npx supabase start` locally), then `npx prisma migrate deploy`. The app's `users` triggers are a Prisma migration that needs the username registry from `supabase/migrations/`. After `npx supabase db reset`, run `npx prisma migrate deploy` again.

The app's data model (projects, branches, commits, files) is described in [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md).

## Authentication

Auth endpoints live under `/api/auth` and use HttpOnly cookie sessions. See [docs/AUTH_API.md](docs/AUTH_API.md) for the endpoint contract and [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) for the auth environment variables and Supabase settings.

## Gotchas

- **Don't install `prisma@latest`.** npm currently tags a Prisma 8 pre-release as `latest`, and it's incompatible with our setup. `npm install` uses the pinned v7.
- **Next.js 16 differs from older tutorials.** For example, `middleware.ts` is now `proxy.ts`. See `AGENTS.md` and the bundled docs in `node_modules/next/dist/docs/`.
- **Enable RLS on every new table.** Supabase exposes new `public` tables through its API by default.
- **Don't run `supabase config push`** unless you mean to overwrite the hosted project's settings with `supabase/config.toml`.
- **The project pauses after about a week of inactivity** (Supabase free tier). If the app can't reach the database, restore it from the Supabase dashboard.
- **`npm install` warns about install scripts not covered by `allowScripts`.** This is expected and harmless: Prisma and ESLint work without them.
