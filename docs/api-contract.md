# Plugin API contract

The API the MuseScore plugin and the web app use to work with projects, branches, and commits. It is based on the Nov 2–6 plan ("ScoreControl: Plugin API Contracts and Backend Plan") with the team's decisions filled in.

The machine-readable version is [`src/lib/api/contract.ts`](../src/lib/api/contract.ts): zod schemas and TypeScript types for every request, response, and error code. **Change both together.** If they disagree, the code is a bug in one of them; ask before picking a side.

Status: **draft for review** by the plugin developer and Ryan. Implemented so far: plugin login and `/api/auth/refresh` (section 4), bearer-token auth with role checks, and the project and branch routes (section 5), sync (section 6), and history (section 8). Commit detail, blobs, and commits are not built yet.

## Contents

1. [Conventions](#1-conventions)
2. [Identifiers and hashes](#2-identifiers-and-hashes)
3. [Endpoints](#3-endpoints)
4. [Auth for the plugin](#4-auth-for-the-plugin)
5. [Projects and branches](#5-projects-and-branches)
6. [Sync (the guard)](#6-sync-the-guard)
7. [Commit (push)](#7-commit-push)
8. [Pull, history, and blobs](#8-pull-history-and-blobs)
9. [Commit message suggestions](#9-commit-message-suggestions)
10. [Error codes](#10-error-codes)
11. [Decisions and changes from the plan](#11-decisions-and-changes-from-the-plan)

## 1. Conventions

- **Base path:** `/api/...`, next to the existing `/api/auth/*` routes.
- **Success:** `{ "data": ... }`, the same envelope the auth routes use.
- **Errors:**
  ```json
  { "error": { "code": "STALE_PARENT", "message": "Branch main has moved.", "details": { ... } } }
  ```
  - `code` is stable and machine-readable. **Clients branch on `code`, never on `message`.**
  - `details` (optional) carries machine-readable context, such as the current branch head.
  - `fields` (optional) holds per-field validation messages, as the auth routes already return.
  - `requestId` (optional) appears on 5xx errors; quote it when reporting a problem.
- **Auth:** every route accepts `Authorization: Bearer <access_token>` (the plugin) or the existing cookie session (the web app), through one shared `requireUser` helper. Project routes then check the caller's role with `requireProjectRole(user, projectId, minRole)`.
- **CSRF:** cookie requests that change state must come from the app's own origin (the existing check). Bearer requests skip that check, because a browser never attaches a bearer token on its own.
- **Plugin headers:**
  - `X-Client: scorecontrol-plugin/<major.minor.patch>`: lets the server answer `426 UPGRADE_REQUIRED` to outdated plugins later.
  - `Idempotency-Key: <8–128 of A–Z a–z 0–9 _ ->` on commits, so a retry after a dropped connection doesn't create a duplicate commit.
- **Caching:** every response is `Cache-Control: private, no-store`.
- **Roles**, weakest to strongest. Each includes everything below it:

  | Role | Can |
  |---|---|
  | `viewer` | Pull, list, view history |
  | `editor` | Commit, create branches |
  | `admin` | Archive and unarchive branches |
  | `owner` | Delete the project (not part of this week's routes) |

  Non-members get `404 NOT_FOUND` rather than `403`, so the API doesn't reveal which private projects exist. Members whose role is too low get `403 FORBIDDEN`.

## 2. Identifiers and hashes

| Thing | Identifier |
|---|---|
| Project | Database UUID, e.g. `3f2b0c1e-8a4d-4c6b-9e1f-2a3b4c5d6e7f` |
| Branch | Name, URL-encoded in paths (names can contain `/`, so `feature/verse-2` is `feature%2Fverse-2`) |
| Commit | Full hash (64 lowercase hex), or any **unique** prefix of at least 7 characters. An ambiguous prefix returns `409 AMBIGUOUS_HASH`. |
| Blob (file contents) | SHA-256 of the bytes (64 lowercase hex) |

**Branch names:** 1 to 64 characters of letters, digits, `.`, `_`, `-`, `/`, unique per project. Also rejected, so branches stay valid git names: a leading `/` or `.`, a trailing `/` or `.lock`, and `..` or `//` anywhere.

**Hashes are always computed by the server**, never trusted from the client:

- **Blob hash:** SHA-256 of the raw file bytes. Stored at `{projectId}/{sha256}` in the private Storage bucket.
- **Commit hash:** SHA-256 of this canonical JSON (keys in this order, no whitespace):
  ```json
  {"parents":["<sorted full hashes>"],"tree":[["<path>","<blob sha256>"],...],"message":"...","authorId":"<uuid>","createdAt":"<ISO 8601 UTC, ms>"}
  ```
  `tree` is sorted by path. The short form shown in the UI is the first 7 characters.

Internally, commits keep their UUID primary key; `hash` is the public identifier.

**Score metadata (inside the score file).** The plugin owns this block and stores it in the score. The server only answers questions about it:

```json
{ "scoreControl": 1, "apiBase": "https://<host>/api", "projectId": "<uuid>",
  "branch": "main", "commitHash": "<64 hex>", "commitMessage": "Add second verse" }
```

This is unrelated to the database table `score_metadata`, which holds musical facts parsed from a blob (title, key, parts).

## 3. Endpoints

| Method | Path | Purpose | Min role |
|---|---|---|---|
| POST | `/api/auth/login` *(exists)* | Add `client: "plugin"` mode that returns tokens in the body | none |
| POST | `/api/auth/refresh` *(new)* | Exchange a refresh token for new tokens | none |
| GET | `/api/auth/me` *(exists)* | Who am I; the plugin calls it on start | user |
| POST | `/api/projects` | Create a project and its empty `main` branch | user |
| GET | `/api/projects` | My projects, each with its default branch head | user |
| GET | `/api/projects/:id` | Project info, my role, branches | viewer |
| GET | `/api/projects/:id/branches` | Branch names and heads | viewer |
| POST | `/api/projects/:id/branches` | Create a branch at a commit | editor |
| PATCH | `/api/projects/:id/branches/:name` | Archive or unarchive | admin |
| GET | `/api/projects/:id/sync` | **Guard and refresh in one call** | viewer |
| GET | `/api/projects/:id/branches/:name/commits` | History, newest first, paginated | viewer |
| GET | `/api/projects/:id/commits/:hash` | Commit detail with its files | viewer |
| GET | `/api/projects/:id/blobs/:sha256` | Download a file (pull) | viewer |
| POST | `/api/projects/:id/commits` | Upload files and create a commit, atomically | editor |
| POST | `/api/projects/:id/commit-message-suggestions` | LLM-suggested message | editor |

Pull requests and merges are out of scope until the diff engine is connected.

## 4. Auth for the plugin

The web app's auth uses HttpOnly cookies, which a plugin can't share, so the plugin uses tokens.

**Log in:** `POST /api/auth/login`

```json
{ "identifier": "ryan", "password": "...", "client": "plugin" }
```

`identifier` is an email or username, as in the web login. With `client: "plugin"`, no cookie is set and the tokens come back in the body (`200`):

```json
{ "data": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1762200000,
            "user": { "id": "<uuid>", "email": "...", "emailVerified": true, "username": "ryan" } } }
```

`expiresAt` is in Unix seconds. Plugin requests have no browser `Origin`, so plugin-mode login is exempt from the origin check; it is still rate-limited like web login.

**Refresh:** `POST /api/auth/refresh` with `{ "refreshToken": "..." }` returns the same shape. Refresh tokens rotate: **always store the new one**, since the old one stops working.

**Using tokens:** send `Authorization: Bearer <accessToken>` on every request. On `401 TOKEN_EXPIRED`, refresh once and retry. If that fails too, or you get `401 UNAUTHENTICATED`, show the login screen.

**Google-only accounts** have no password, so they can't use the plugin yet. Proposed follow-up: a personal access token created in the web app, or a device-code flow (the plugin shows a code, the user approves it in the browser). This week's demo uses a password account.

## 5. Projects and branches

### Create a project

`POST /api/projects` with `{ "name": "Sonata in D", "format": "MUSICXML" }`. `format` defaults to `MUSICXML`; `description` is optional.

`201`:

```json
{ "data": {
  "project": { "id": "<uuid>", "name": "Sonata in D", "slug": "sonata-in-d", "description": null,
               "role": "owner", "defaultBranch": "main", "createdAt": "2026-11-03T18:00:00.000Z" },
  "branch": { "name": "main", "headHash": null, "headMessage": null, "archived": false }
} }
```

The slug is generated from the name and made unique per owner (`sonata-in-d-2`, ...). The plugin then pushes the first commit with `parentHash: null`. If that second call fails, the project stays empty; the plugin just retries the commit against it.

### List and get

- `GET /api/projects` → `{ "projects": [ { ...project, "head": <branch> } ] }`, where `head` is the default branch.
- `GET /api/projects/:id` → `{ "project": ..., "branches": [ ... ] }`.
- `GET /api/projects/:id/branches` → `{ "branches": [ ... ] }`. Archived branches are left out unless you pass `?includeArchived=1`.

A branch is always:

```json
{ "name": "main", "headHash": "<64 hex or null>", "headMessage": "Fix bar 12", "archived": false }
```

### Create a branch

`POST /api/projects/:id/branches` with `{ "name": "modified", "fromHash": "ab12cd3" }` → `201 { "branch": ... }`. A taken name returns `409 BRANCH_EXISTS`. Use this for explicit branch creation; the commit route creates branches itself when forking (section 7).

### Archive

`PATCH /api/projects/:id/branches/:name` with `{ "archived": true }` (or `false`) → `200 { "branch": ... }`. The default branch can't be archived (`422 VALIDATION_FAILED`). Committing to an archived branch returns `409 BRANCH_ARCHIVED`.

## 6. Sync (the guard)

`GET /api/projects/:id/sync?branch=main&commit=<localHash>`

One call serves three plugin needs: the pre-commit guard, the "refresh" button, and the status header.

| Query | Default | Meaning |
|---|---|---|
| `branch` | `main` | The branch the score is on |
| `commit` | none | The commit recorded in the score. Omit for a score that was never committed. |
| `includeArchived` | `0` | `1` includes archived branches in `branches` |

`200`:

```json
{ "data": {
  "branch": { "name": "main", "headHash": "ab12...", "headMessage": "Fix bar 12", "archived": false },
  "relation": "behind",
  "commitsAhead": 2,
  "branches": [
    { "name": "main", "headHash": "ab12...", "headMessage": "Fix bar 12", "archived": false },
    { "name": "modified", "headHash": "77c0...", "headMessage": "Try new voicing", "archived": false }
  ],
  "role": "editor"
} }
```

`relation` is computed by walking the commit graph:

| Relation | Meaning | Plugin does |
|---|---|---|
| `same` | The local commit is the branch head | Normal commit |
| `behind` | The local commit is an ancestor of the head; `commitsAhead` says by how many | Warn "a new branch will be created", then fork (section 7) |
| `unrelated` | The local commit isn't in this branch's history (e.g. the user switched branches by hand) | Same as `behind` |
| `empty` | The branch has no commits yet | First commit with `parentHash: null` |
| `none` | No `commit` was sent | Treat as a new score |

`commitsAhead` is `0` unless `relation` is `behind`. A `commit` that doesn't exist in the project returns `unrelated`, not an error, so a stale score still gets a usable answer. A missing branch returns `404 NOT_FOUND`.

`branches` lists names and heads only, which covers User2's "show all branches" button. Full hashes for a branch come from the history endpoint.

## 7. Commit (push)

`POST /api/projects/:id/commits` as `multipart/form-data`, with the `Idempotency-Key` header:

- a `metadata` part (JSON, below)
- one part per entry in `files`, named by that entry's `field`, holding the file bytes

```json
{
  "branch": "main",
  "parentHash": "ab12...",
  "message": "Add second verse",
  "newBranch": null,
  "aiSummary": "optional, from the suggestion's summary",
  "files": [ { "field": "f0", "path": "sonata.musicxml", "format": "MUSICXML", "role": "primary" } ]
}
```

- `files` is the **full snapshot**, not only changed files: a path you leave out is deleted in this commit.
- Exactly one file has `role: "primary"` (the score the diff engine and LLM read). `"native"` (a `.mscz` for exact restores) and `"attachment"` are allowed but not used yet.
- `format` defaults to `MUSICXML`, `role` to `primary`.

**Server steps, all in one transaction:**

1. Check the role (editor), the limits (25 MB per file, 100 files), and hash every file.
2. Lock the target branch row (`SELECT ... FOR UPDATE`).
3. **No `newBranch`:** `parentHash` must equal the branch head (or both are null for the first commit). Otherwise `409 STALE_PARENT`.
4. **With `newBranch`:** `parentHash` must be an existing commit in this project. The server creates `newBranch.name` pointing at it and commits onto the new branch. This handles both "edit an old commit, then commit" and "someone committed first". A taken name returns `409 BRANCH_EXISTS`.
5. Upload new blobs to Storage, insert the rows, and move the branch head.
6. Return the new commit.

`201`:

```json
{ "data": {
  "commit": { "hash": "c3d4...", "shortHash": "c3d4e5f", "message": "Add second verse", "parents": ["ab12..."],
              "createdAt": "2026-11-03T18:22:10.000Z", "author": { "id": "<uuid>", "username": "ryan" } },
  "branch": { "name": "main", "headHash": "c3d4...", "headMessage": "Add second verse", "archived": false, "created": false }
} }
```

**The stale response**, the key contract for two people committing at once:

```json
{ "error": { "code": "STALE_PARENT", "message": "Branch main has moved.",
  "details": { "branch": "main", "headHash": "ab12...", "headMessage": "Fix bar 12",
               "yourParent": "9f2c...", "commitsAhead": 1 } } }
```

`commitsAhead` is how far the head is past `yourParent`, or `null` when `yourParent` isn't in the branch's history. The plugin shows the warning, asks for a branch name, and resends the **same payload** with `"newBranch": { "name": "ryan-alt" }` (and a new `Idempotency-Key`). Because the commit route enforces this itself, a race between the sync call and the commit can't silently overwrite or fork history.

**Other behavior:**

- A snapshot identical to its parent's returns `422 NO_CHANGES`.
- Retrying with the same `Idempotency-Key` and the same request returns the original `201`. The same key with a different request returns `409 IDEMPOTENCY_CONFLICT`. Keys are kept for 24 hours.
- Parsing the primary file into `parsed_ast` happens in the background after the response, so commits never wait on the parser.

## 8. Pull, history, and blobs

**Pull** is two reads, which covers all three checkout cases (an old commit, a branch head, the latest):

1. `GET /api/projects/:id/commits/:hash` → `{ "commit": { ...summary, "aiSummary": null, "files": [ { "path", "format", "role", "sha256", "size" } ] } }`. For a branch head, use `headHash` from sync, or `GET .../branches/:name/commits?limit=1`.
2. `GET /api/projects/:id/blobs/:sha256` → the raw bytes, with `Content-Type` and `Content-Length`. The server checks that the blob belongs to this project and that the caller is a member. Add `?encoding=base64` to get `{ "data": { "sha256", "size", "contentType", "base64" } }` instead, a fallback in case the plugin runtime handles binary responses poorly.

After writing the file into the score, the plugin updates its embedded metadata (project, branch, commit hash, message).

**History:** `GET /api/projects/:id/branches/:name/commits?limit=30&cursor=<opaque>` → `{ "commits": [ <summary>, ... ], "nextCursor": "..." }`, newest first, following first parents from the head. `limit` is 1–100 (default 30). `nextCursor` is `null` on the last page; treat it as opaque.

## 9. Commit message suggestions

`POST /api/projects/:id/commit-message-suggestions`: multipart, with the same file parts as a commit and this `metadata`:

```json
{ "branch": "main", "parentHash": "ab12...", "files": [ { "field": "f0", "path": "sonata.musicxml" } ] }
```

`200`:

```json
{ "data": { "suggestion": "Add second verse and fix dynamics in bars 24-30",
            "summary": "Longer what-changed description, or null",
            "model": "<provider/model>", "basis": "simple_diff" } }
```

- The server compares the new primary file with the parent commit's and sends a **compact diff** to the model, never both full files. Until the diff engine is connected, that's a simple measure-level MusicXML diff (`basis: "simple_diff"`). First commits get a suggestion from the file's title and parts (`"initial_commit"`).
- **Advisory only:** errors, timeouts (about 10 seconds), and `429` must never block committing. The plugin falls back to an empty message box, and the user can always edit the suggestion.
- To keep `summary`, send it as `aiSummary` in the commit metadata.
- Per-user rate limit and a daily cost cap. The provider sits behind one `suggestCommitMessage(diff)` function so it can be swapped.

## 10. Error codes

| HTTP | Code | When | Plugin does |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | Malformed body, query, or headers (`fields` says which) | Fix the request |
| 401 | `UNAUTHENTICATED` | No or invalid credentials | Show login |
| 401 | `TOKEN_EXPIRED` | Access token expired | Refresh once and retry, else show login |
| 403 | `FORBIDDEN` | Role too low (e.g. a viewer committing) | Show a role message |
| 403 | `ORIGIN_NOT_ALLOWED` | Cookie request from another origin | (web app only) |
| 404 | `NOT_FOUND` | Project, branch, commit, or blob gone, or not a member | Offer refresh |
| 409 | `AMBIGUOUS_HASH` | Hash prefix matches several commits | Use more characters |
| 409 | `STALE_PARENT` | Branch moved since `parentHash` | Warn and run the new-branch flow |
| 409 | `BRANCH_EXISTS` | Branch name taken | Ask for another name |
| 409 | `BRANCH_ARCHIVED` | Committing to an archived branch | Choose another branch |
| 409 | `IDEMPOTENCY_CONFLICT` | Key reused with a different request | Use a new key per commit |
| 413 | `FILE_TOO_LARGE` | A file is over 25 MB | Show the limit |
| 413 | `TOO_MANY_FILES` | Over 100 files in the snapshot | Show the limit |
| 413 | `REQUEST_TOO_LARGE` | Whole request too large | Show the limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Wrong `Content-Type` | Fix the request |
| 422 | `NO_CHANGES` | Snapshot identical to the parent | Nothing to commit |
| 422 | `VALIDATION_FAILED` | Valid shape, but not allowed (e.g. archiving the default branch) | Show the message |
| 426 | `UPGRADE_REQUIRED` | Plugin too old | Ask the user to update |
| 429 | `RATE_LIMITED` | Too many requests (`Retry-After` header) | Back off; suggestions fall back to manual |
| 500 | `INTERNAL_ERROR` | Bug (`requestId` included) | Show a generic error |
| 503 | `SERVICE_UNAVAILABLE` | Database, storage, or auth provider down | Retry later |

The existing auth routes return a few more auth-specific codes (`INVALID_CREDENTIALS`, `EMAIL_NOT_CONFIRMED`, ...); see [`AUTH_API.md`](AUTH_API.md).

## 11. Decisions and changes from the plan

Decided 2026-11-05:

1. **Commit identity:** commits keep their UUID primary key and gain a `hash` column (unique per project) as the public identifier.
2. **100-file limit:** counts distinct paths in one commit's snapshot, not blobs across history.
3. **LLM provider:** Claude Haiku, behind the swappable `suggestCommitMessage(diff)`.
4. **Files the plugin pushes:** MusicXML as the single `primary` file, as the plan specifies. The `native` role is reserved for pushing the MuseScore file later.

Additions to the plan, for review:

- **Error envelope:** the auth routes return validation messages as `fields`; the plan calls the context object `details`. Both are supported: `details` for machine-readable context, `fields` for per-field messages.
- **`relation: "none"`** in sync, for a score with no commit yet.
- **`AMBIGUOUS_HASH`** and **`IDEMPOTENCY_CONFLICT`** error codes, which the plan's rules imply but don't name.
- **Non-members get `404`, not `403`**, so private project ids aren't confirmed to outsiders.
- **Bearer requests skip the origin (CSRF) check**, which only protects cookie sessions.
- Branch names also follow git's rules (no `..`, leading `.`, and so on).
- Projects get a `slug`, because the schema requires one (unique per owner).

Still open (from the plan's risks):

- **Detecting local changes:** re-exported MusicXML can differ byte for byte with no musical change. The server returns `NO_CHANGES` only for identical bytes. Should the plugin use MuseScore's modified flag, or should the server normalize MusicXML before hashing?
- **Where parsing happens:** server-side in the background (proposed), or the plugin sends a parsed form. Confirm with the diff team.
- **Large uploads:** if files near 25 MB hit the host's request body limit, switch to a two-step upload (check missing hashes, upload straight to Storage, commit by reference). Only the commit request body would change.
