# Authentication API

Supabase Auth owns passwords, email verification, tokens, and sessions. The backend keeps the session in HttpOnly cookies; the frontend never sees tokens and must not create its own Supabase browser-auth session. Send JSON mutations to the same origin with `Content-Type: application/json`. Requests whose `Origin` is not exactly `APP_ORIGIN` get 403. All responses are `no-store`.

A user is `{ id, email, emailVerified, username }`. Every new account has a username; it is null only for accounts created before usernames were required. Only `id` identifies the account for ownership.

## Endpoints

| Method/path | Body | Success |
|---|---|---|
| `POST /api/auth/signup` | `{ "email", "password", "username" }` | 201 `{ data: { status: "authenticated", user } }` if Supabase returned a session, else 202 `{ data: { status: "confirmation_required" } }` |
| `POST /api/auth/login` | `{ "identifier", "password", "rememberMe"? }` | 200 `{ data: { user } }` and session cookies. `identifier` is a username or email |
| `GET /api/auth/me` | none | 200 `{ data: { user } }`, or 401 when signed out |
| `POST /api/auth/logout` | `{}` | 204; signs out this browser/session only |
| `POST /api/auth/resend-confirmation` | `{ "email" }` | 202 `{ data: { status: "accepted" } }` for known and unknown addresses |
| `POST /api/auth/username` | `{ "username" }` | 200 `{ data: { user } }`; for accounts created before usernames were required, which claim one once |
| `POST /api/auth/forgot-password` | `{ "email" }` | 202 `{ data: { status: "accepted" } }` for known and unknown addresses |
| `POST /api/auth/reset-password` | `{ "tokenHash", "password" }` | 200 `{ data: { status: "password_updated", otherSessionsRevoked } }`; signs this browser in |
| `POST /api/auth/password` | `{ "password", "currentPassword"? }` | Same 200 body; requires a session |
| `GET /auth/confirm` | email link | Signup link: 303 to `/login?status=email_confirmed` (token-hash) or `/` signed in (default template). Default-template reset link: 303 to `/reset-password` signed in |

## Input rules

- Passwords: 8+ characters at signup (Supabase policy is authoritative), up to 1,024; never trimmed. Login accepts shorter legacy passwords.
- Usernames: required at signup; 1-39 ASCII letters, digits, and single inner hyphens; stored lowercase; reserved names rejected. Once set, a username cannot be changed through this API.
- Login also accepts `email` instead of `identifier` (exactly one of the two). `rememberMe` must be a boolean, default false. Unknown fields are rejected. Bodies are limited to 8 KiB.

## Password reset and change

- **Reset:** the token in a reset link is used only when the user submits a new password (validated first, so a too-short password does not burn the link). Success signs this browser in, not remembered. If Supabase then rejects the password, the browser stays signed in and can retry through `/api/auth/password` without another email.
- **Change:** needs the current password, checked with a separate in-memory sign-in that never touches browser cookies and shares the per-account login limit. The current password may be omitted only within 15 minutes of signing in from a reset link.
- Every password update signs out the user's other sessions. `otherSessionsRevoked: false` means the password changed but that sign-out was not confirmed.

## Sessions and cookies

- Cookies: `sc-auth` (or chunks `sc-auth.N`), `sc-auth-persistence`, and `sc-auth-code-verifier` during email confirmation. All are HttpOnly, SameSite=Lax, Path=/, host-only, and Secure on HTTPS.
- Without remember me, cookies last for the browser session. With remember me, they persist for 30 days, renewed whenever the session refreshes. This controls the browser only; Supabase session lifetime is set in Supabase.
- Sessions refresh on server requests (pages via `src/proxy.ts`, API routes themselves). Refresh keeps the remember-me choice.
- Logout revokes the current Supabase session and clears all auth cookies, even if revocation fails (then 503 `LOGOUT_INCOMPLETE`). Other devices stay signed in.
- A provider outage returns 503, never 401. The frontend must not treat 503 as signed out.

## Errors

Errors are `{ error: { code, message, fields?, requestId? } }`. Provider messages, tokens, and private emails are never returned.

| HTTP | Codes |
|---|---|
| 400 | `INVALID_REQUEST`, `WEAK_PASSWORD`, `AUTH_REQUEST_FAILED`, `RECOVERY_LINK_INVALID`, `CURRENT_PASSWORD_REQUIRED`, `INVALID_CURRENT_PASSWORD`, `SAME_PASSWORD` |
| 401 | `INVALID_CREDENTIALS`, `UNAUTHENTICATED` |
| 403 | `EMAIL_NOT_CONFIRMED`, `ORIGIN_NOT_ALLOWED`, `REAUTHENTICATION_REQUIRED` |
| 409 | `USERNAME_TAKEN`, `USERNAME_ALREADY_SET` |
| 413 / 415 | `REQUEST_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| 429 | `RATE_LIMITED` (honor `Retry-After`) |
| 503 | `AUTH_UNAVAILABLE`, `AUTH_NOT_CONFIGURED`, `RATE_LIMIT_UNAVAILABLE`, `RATE_LIMIT_NOT_CONFIGURED`, `CLIENT_IP_UNAVAILABLE`, `USERNAME_UNAVAILABLE`, `LOGOUT_INCOMPLETE`, `SESSION_REFRESH_REQUIRED` |
| 500 | `INTERNAL_ERROR` (includes `requestId`) |

Duplicate-email signup returns the same 202 as a new signup, so it does not reveal registered addresses.

## Frontend integration

The frontend owns the forms and the `/login` and `/reset-password` pages. Paths the backend redirects to are in `src/lib/auth/paths.ts`.

- `/login` should handle `?error=` (`confirmation_failed`, `rate_limited`, `unavailable`), `?status=email_confirmed`, and `?next=`. Validate `next` with `safeReturnPath()` from `paths.ts` before navigating.
- `/reset-password` is opened directly from the reset email as `/reset-password#token_hash=...`. It reads `token_hash` from `location.hash` and posts it with the new password to `/api/auth/reset-password`. Do not copy the token into the query string, logs, or analytics. Without a fragment, the browser already holds a recovery session (same-browser link): post only `password` to `/api/auth/password`.
- Call `/api/auth/me` on load and after login/logout. If `username` is null, send the user to a username form that posts to `/api/auth/username`. Same-origin `fetch` sends the cookies automatically.

## Protecting backend routes and pages

- **Route Handlers:** `withAuthenticatedRoute(request, async (user, client) => response)` from `src/lib/auth/guards.ts`. It rejects cross-origin POST/PUT/PATCH/DELETE, returns 401 when signed out, and keeps refreshed cookies. `user` is `{ id, email, emailVerified }` with no username lookup; call `usernameForUser(user.id)` if needed.
- **Server Components:** `requirePageUser(returnTo?)` from `src/lib/auth/user.ts` redirects signed-out visitors to `/login` (with a validated `next`). `getCurrentUser()` returns the full user or null.
- Always take ownership from the verified `user.id`, never from request fields, usernames, or user metadata. Proxy only refreshes cookies; it does not authorize anything.
