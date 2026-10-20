# Auth environment and setup

## Variables

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Public. Supabase project URL (local: `supabase status`). |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes | Public. Must be an `sb_publishable_...` key; legacy JWT `anon` keys and secret keys are rejected. |
| `APP_ORIGIN` | Yes | Exact app origin, e.g. `http://localhost:3000`. HTTPS except on loopback; no path. Used for CSRF checks, email links, and cookie `Secure`. |
| `UPSTASH_REDIS_REST_URL` | Production | Server-only. Upstash Redis REST URL for rate limiting. Leave empty locally to use in-memory limits. |
| `UPSTASH_REDIS_REST_TOKEN` | Production | Server-only secret, read/write. Set together with the URL. |
| `AUTH_TRUSTED_IP_HEADER` | Production | Header your hosting edge overwrites with exactly one client IP (e.g. `x-real-ip`, only if guaranteed). Missing or invalid fails closed in production. |
| `SUPABASE_SECRET_KEY` | Yes | Server-only `sb_secret_...` key from the same project, used for username lookups. Legacy JWT `service_role` keys are rejected. Never `NEXT_PUBLIC_`. |

Public values are inlined at build time, so set them before building each environment. Use `localhost` or `127.0.0.1` consistently; they are different origins.

## Supabase settings (dashboard)

- Enable email/password sign-in. Decide whether email confirmation is required (production should require it; local `config.toml` has it off).
- Set Site URL to `APP_ORIGIN` and add `${APP_ORIGIN}/auth/confirm` to the redirect allowlist for each environment.
- Email template links (Authentication > Emails). Both work on any device; the default templates also work, but only in the browser that started the flow.
  - Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` (confirms without signing in; the user then logs in).
  - Reset password: `{{ .SiteURL }}/reset-password#token_hash={{ .TokenHash }}`. The token stays in the URL fragment, which browsers never send to a server, so it cannot appear in access logs; it is used only when the user submits a new password.
- Configure custom SMTP for real users; the default sender is heavily restricted.
- Do not run `supabase config push` to apply these; it overwrites the hosted project's settings.

## Username migration

Every account needs a username. `supabase/migrations/20261019000000_auth_usernames.sql` adds a private `scorecontrol_auth.usernames` table (unique lowercase handle per auth user, deleted with the user), a signup trigger that registers the handle atomically and rejects new email accounts without one, and three RPCs callable only with the secret key: `auth_resolve_username`, `auth_username_for_user`, `auth_claim_username`. It does not touch Prisma or application tables.

Apply it before the app runs against a project: `npx supabase migration up --local` locally, or the team's normal `supabase db push` workflow for hosted projects (check pending migrations first). Without it, signup, login, and `/api/auth/me` return 503.

Users created in the Supabase dashboard or admin API also need a username: pass `{ "scorecontrol_username": "<handle>" }` as user metadata, or the insert is rejected. Accounts that existed before the migration have no username and claim one through `POST /api/auth/username`.

Keep `scorecontrol_auth` out of the Data API's exposed schemas. The RPCs live in `public`, which Prisma also manages: `prisma migrate reset` deletes them, and username login returns 503 until the migration is re-applied.

## Rate limits

Per IP: login and password change 30 per 5 min, signup and username claims 5 per hour, resend and forgot-password 10 per hour each, email-link and reset verification 30 per 5 min. Per account: login and current-password checks 10 per 5 min, resend and forgot-password 3 per hour each. A global ceiling of 1,000 times each per-IP limit is checked last, and rejected requests use no quota. Production returns 503 if Redis or the trusted IP header is missing.

## Before launch

- Every auth call reaches Supabase from the server's IP. Check whether the hosted project's per-IP auth limits then apply to the whole site, and raise them if so.
- With legacy HS256 JWT signing, the proxy calls Supabase on every page request with a session. Asymmetric signing keys let it verify locally.
- Each deployment URL (www, apex, previews) needs its own `APP_ORIGIN` and redirect allowlist entry, or mutations return 403.

## Testing

- `npm test`: unit, handler, SDK, and migration tests (embedded Postgres). No services needed.
- `npm run test:smoke`: Chromium against the app on port 3100 and a simulated provider on 54329. Run `npx playwright install chromium` once.
- `npm run test:integration`: Chromium against a real local Supabase (port 3000). Put these in ignored `.env.test.local`:

```dotenv
AUTH_TEST_SUPABASE_URL=http://127.0.0.1:54321
AUTH_TEST_SUPABASE_PUBLISHABLE_KEY=<from supabase status>
AUTH_TEST_SUPABASE_SECRET_KEY=<from supabase status>
```

Never point the integration suite at a hosted project. The reset-email test reads local Mailpit (port 54324), and local Supabase sends at most 2 auth emails per hour, so that test fails if the suite runs more than twice in an hour.
