# Headroom: Technical Documentation

**Version:** 1.0 (August 2026)
**Live at:** https://headroom.me.uk
**Maintainer:** David (solo developer)

---

## 1. Overview

Headroom is a stress-tracking web application built on a "stress bucket" model. Users log events that add to their stress level (fillers, called "Load" in the UI) or reduce it (emptiers, called "Relief"). The bucket level is a number from 0 to 100. Headroom is the inverse: `headroom = 100 - level`.

Key product concepts:

- **Items** are the user's personal catalogue of stressors and relievers, each with a default impact value (1 to 50).
- **Entries** are individual logged events. Tapping an item creates an entry, applying its value (positive for fillers, negative for emptiers) to the running level.
- **The bucket does not reset at midnight.** The current level is always the `level_after` of the most recent entry, whenever it was logged. Stress persists until acted on.
- **Tiers** gate features: free accounts have limited items and history; full accounts (including early adopters) get everything, including share links and pattern analytics.
- **Share links** let a user publish a read-only view of their bucket (for a therapist, partner, or friend) via an unguessable token.
- **GDPR support** is built in: consent logging, full data export, and self-service account deletion.

## 2. Architecture

```
┌─────────────┐     ┌──────────────────────────┐     ┌──────────────┐
│   Browser    │────▶│  Express (Node.js)        │────▶│  PostgreSQL   │
│  (React SPA, │     │  Render, behind LB        │     │  (Render)     │
│   PWA + SW)  │     │  trust proxy = 1          │     └──────────────┘
└─────────────┘     │                            │
┌─────────────┐     │  /api/* JSON routes        │     ┌──────────────┐
│ Flutter app  │────▶│  static files from public/ │────▶│  Resend       │
│  (planned)   │     │  SPA fallback to index.html│     │  (email)      │
└─────────────┘     └──────────────────────────┘     └──────────────┘
```

### 2.1 Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20, Express |
| Database | PostgreSQL (pg pool, max 10 connections) |
| Frontend | Single-page React 18 app (UMD builds + babel-standalone from cdnjs), served from `public/`, hash-based routing (`/#/...`) |
| PWA | Service worker (`sw.js`), web app manifest, push notifications |
| Email | Resend (transactional) |
| Hosting | Render (web service + managed PostgreSQL), `trust proxy` enabled |
| DNS | Cloudflare |
| Payments | Stripe route scaffolded but currently disabled (commented out in `server.js`); donations table exists |

### 2.2 Repository layout

```
headroom/
├── server.js              # App entry: middleware, route mounting, migrations, listen
├── db.js                  # pg pool + query/queryOne/transaction helpers
├── migrate.js             # Sequential SQL migration runner
├── migrations/            # Numbered .sql files (e.g. 004-password-resets.sql)
├── middleware/
│   ├── auth.js            # requireAuth, optionalAuth (cookie + bearer)
│   ├── admin.js           # requireAdmin
│   ├── tier.js            # hasFullAccess, requireFull, getTierLimits
│   └── rate-limit.js      # authLimiter, apiLimiter
├── routes/
│   ├── auth.js            # Register, login, logout, me, password, profile, reset flow
│   ├── email.js           # Resend integration (password reset emails)
│   ├── onboarding.js      # Starter items, onboarding completion
│   ├── items.js           # Item CRUD + reorder
│   ├── entries.js         # Entry logging, history, delete + recalculation
│   ├── bucket.js          # Current bucket state
│   ├── share.js           # Share link CRUD + public shared view
│   ├── patterns.js        # Analytics (full tier)
│   ├── user.js            # GDPR export and account deletion (/api/me)
│   └── admin.js           # Admin console API
├── public/                # Static SPA (index.html, sw.js, manifest, icons)
├── _archive/              # Local only, gitignored
├── render.yaml            # Render deployment config
└── package.json
```

### 2.3 Request lifecycle

1. `express.json()` parses JSON bodies; `cookie-parser` parses cookies.
2. `apiLimiter` applies to everything under `/api/` (120 requests/minute per IP).
3. Route-level middleware runs: `authLimiter` on sensitive auth endpoints, `requireAuth` on protected routes, `requireFull`/`requireAdmin` where applicable.
4. Handlers use parameterised queries via `db.js` helpers. Multi-step writes use `transaction()`.
5. Unknown `/api/*` paths return JSON 404. All other unknown paths fall back to `public/index.html` (SPA routing).

### 2.4 Startup

`start()` in `server.js`:
1. If `DATABASE_URL` is set, run migrations (`migrate.js`). A migration failure logs an error but the server still starts (database features will not work). Note: in practice a failed migration exits the process with status 1 from within `migrate()` when run at boot, so Render treats it as a failed deploy and restarts.
2. Listen on `PORT` (Render provides this; local default 3000).

### 2.5 Migration system

- `migrations` table records applied filenames.
- Files in `migrations/` matching `*.sql` are sorted lexicographically and applied in order inside a transaction; success inserts the filename into `migrations`.
- A failed migration rolls back and exits the process.
- **Convention:** number files sequentially (`001-...sql`, `002-...sql`) and always write idempotent SQL (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) so partial failures can be retried safely.
- **Recovery from a partially applied migration:** fix the schema manually (e.g. via DBeaver), then `INSERT INTO migrations (filename) VALUES ('the-file.sql')` to mark it applied.

## 3. Data model

Schema as inferred from application code. Columns marked (?) are used by code but their exact definition lives in the migration files.

### users
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| email | TEXT UNIQUE | Stored trimmed + lowercased |
| password_hash | TEXT | bcrypt, 12 rounds |
| display_name | TEXT NULL | |
| tier | TEXT | 'free', 'full', or 'early_adopter' |
| early_adopter | BOOLEAN | Set true for launch-mode signups |
| is_admin | BOOLEAN | |
| timezone | TEXT | IANA name, default 'Europe/London' |
| onboarded_at | TIMESTAMPTZ NULL | Set when onboarding completes |
| last_active_at | TIMESTAMPTZ | Updated on login and on every authenticated request (fire-and-forget) |
| created_at / updated_at | TIMESTAMPTZ | |

### sessions
| Column | Type | Notes |
|---|---|---|
| user_id | INT FK users | |
| token | TEXT | 32 random bytes, hex (64 chars). Stored in plaintext; treat the sessions table as sensitive |
| expires_at | TIMESTAMPTZ | 30 days from creation. Expired rows cleaned hourly by an in-process interval |

### items
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| user_id | INT FK users | ON DELETE CASCADE (?) |
| label | TEXT | Max 60 chars (enforced in code) |
| type | TEXT | 'filler' or 'emptier' |
| default_value | INT | 1 to 50 |
| sort_order | INT | Per-type ordering |
| active | BOOLEAN | Soft delete flag |
| created_at | TIMESTAMPTZ | |

### entries
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| user_id | INT FK users | |
| item_id | INT FK items | |
| value | INT | Signed delta: positive for fillers, negative for emptiers |
| level_after | INT | Bucket level (0 to 100) after this entry |
| logged_at | TIMESTAMPTZ | Server time at logging |

### share_tokens
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| user_id | INT FK users | |
| token | TEXT | 32 random bytes, hex. Unguessable public identifier |
| label | TEXT | Max 60 chars |
| settings | JSONB | { showChart, showLog, showItemLabels }, all default true |
| created_at | TIMESTAMPTZ | |
| revoked_at | TIMESTAMPTZ NULL | Non-null means revoked. Max 10 active per user |

### password_resets
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| user_id | INT FK users ON DELETE CASCADE | |
| token_hash | CHAR(64) UNIQUE | SHA-256 hex of the raw token. Raw token never stored |
| expires_at | TIMESTAMPTZ | 1 hour from creation |
| used_at | TIMESTAMPTZ NULL | Single use; kept as audit trail |
| created_at | TIMESTAMPTZ | |

### consent_log
| Column | Type | Notes |
|---|---|---|
| user_id | INT FK users | |
| consent_type | TEXT | 'registration', 'data_export', 'account_deletion' |
| consent_text | TEXT | Snapshot of the consent wording shown |
| ip_address | TEXT | From req.ip (trust proxy enabled) |
| created_at | TIMESTAMPTZ | |

### config
Key-value store driving runtime behaviour without redeploys.
| Key | Meaning | Default in code |
|---|---|---|
| signup_mode | 'launch' or 'freemium' | 'launch' |
| launch_tier | Tier granted to launch signups | 'full' |
| freemium_tier | Tier granted to freemium signups | 'free' |
| max_items_free | Active item cap for free tier | 5 |
| max_history_days_free | History window cap for free tier | 7 |
| registration_consent_text | Consent wording logged at signup | fallback string |

Tier limits are cached in memory for 5 minutes (`getTierLimits`).

### partner_codes
| Column | Notes |
|---|---|
| code | Stored uppercased, unique |
| label | |
| tier_assignment | Default 'full' |
| max_uses | Nullable |
| expires_at | Nullable |

### donations
| Column | Notes |
|---|---|
| user_id | Nullable FK; set NULL on user deletion to preserve financial records |
| amount_pence | Integer pence |
| currency | e.g. 'gbp' |
| created_at | |

### migrations
| Column | Notes |
|---|---|
| filename | Unique, applied migration file |
| applied_at | |

## 4. Authentication and security

### 4.1 Session model

- Login/registration creates a row in `sessions` with a 256-bit random token, valid 30 days.
- **Web clients:** the token is delivered as an httpOnly cookie named `session` (`secure` in production, `sameSite=lax`, path `/`, 30-day maxAge).
- **Mobile clients:** send header `X-Client: mobile` on register/login; the response then includes the raw session token in the JSON body (`token` field) instead of relying on the cookie. Store it in platform secure storage (Keychain / Keystore via flutter_secure_storage).
- **Authenticating requests:** `requireAuth` accepts either the `session` cookie or `Authorization: Bearer <token>`. Cookie is checked first.
- Every authenticated request updates `users.last_active_at` asynchronously.
- Expired sessions are deleted by an hourly in-process cleanup.

### 4.2 Passwords

- Hashed with bcrypt, 12 rounds.
- Minimum length 8 characters (no composition rules).
- Changing password (logged in) requires the current password and deletes all *other* sessions.
- Resetting password (forgot flow) deletes *all* sessions.

### 4.3 Password reset flow

1. `POST /api/auth/forgot-password` with an email. The response is always `{ ok: true }` whether or not the account exists (prevents email enumeration).
2. If the account exists: a 256-bit token is generated; its SHA-256 hash is stored in `password_resets` with a 1-hour expiry; the raw token is emailed via Resend as a link: `https://headroom.me.uk/reset-password?token=<raw>`.
3. `POST /api/auth/reset-password` with `{ token, newPassword }`. The server hashes the presented token, looks up an unexpired, unused row, updates the password, marks the row used (audit trail retained), and deletes all sessions.

Email sending is fire-and-forget: a Resend failure is logged but the API still returns `{ ok: true }`.

### 4.4 Rate limiting

| Limiter | Applied to | Limit |
|---|---|---|
| authLimiter | register, login, forgot-password, reset-password | 15 requests per 15 minutes per IP |
| apiLimiter | all of /api/ | 120 requests per minute per IP |

Both send standard `RateLimit-*` headers and a JSON error body on 429.

### 4.5 Other security properties

- All SQL uses parameterised queries (no string interpolation of user input into SQL values).
- Multi-step writes (registration, onboarding, reset, deletion) run in transactions.
- Share tokens and session tokens are 32 bytes of `crypto.randomBytes`.
- `trust proxy` is set to 1 so `req.ip` and `secure` cookies work correctly behind Render's load balancer.
- Postgres connection uses SSL in production with `rejectUnauthorized: false` (acceptable on Render's network; revisit if the database moves).
- Login and register are the only places that reveal account existence (register returns 409 for an existing email). The reset flow does not.

### 4.6 Known gaps (mobile-readiness fixes for Phase 1)

These were identified during documentation and should be fixed before or during Flutter integration:

1. Registration email enumeration (409) is a deliberate UX trade-off; note it in the threat model.
2. No email verification at registration yet (planned: soft verification with a nag).
3. No breach-password checking or account lockout beyond rate limiting (nice-to-have).

## 5. Email service

`routes/email.js` wraps Resend.

- **Env var:** `RESEND_API_KEY` (set in Render environment).
- **Current from address:** `onboarding@resend.dev` (Resend's test domain). In test mode Resend only delivers to the account owner's own address.
- **Production plan:** `headroom.me.uk` is being verified in Resend (DNS records auto-managed via Cloudflare integration). Once verified, change `from:` to `noreply@headroom.me.uk` (no mailbox needs to exist).
- Currently used for password reset only. Future: registration verification, notification digests.

## 6. Frontend (web)

- Single `index.html` SPA in `public/`, React 18 via CDN UMD builds with babel-standalone (no build step).
- Hash-based client routing; the shared read-only view lives at `/#/shared/<token>`.
- **Service worker** (`sw.js`, cache name `headroom-v4`):
  - Pre-caches the app shell (root, manifest, icons, fonts, React CDN scripts) on install.
  - `/api/` requests are always network, never cached.
  - Everything else is network-first with cache fallback (offline support).
  - Old caches are purged on activate; `skipWaiting` + `clients.claim` for immediate takeover.
- PWA installable with push notification support.

## 7. Environment and deployment

| Variable | Purpose |
|---|---|
| DATABASE_URL | Postgres connection string (Render managed DB) |
| RESEND_API_KEY | Resend API key for transactional email |
| NODE_ENV | 'production' enables secure cookies and DB SSL |
| PORT | Provided by Render (falls back to 3000 locally) |

Deployment is git-push driven: pushing to `main` triggers a Render deploy, which runs `node server.js` (migrations run at boot). `render.yaml` holds the service definition.

**Operational notes:**
- Deploy failures from migrations: see section 2.5 recovery procedure.
- Slow queries (>500ms) are logged with truncated SQL and duration.
- Web concurrency is 1 (single instance); the hourly session cleanup interval is safe. If scaled to multiple instances, move periodic jobs to a proper scheduler.

---

## 8. API Reference

Base URL: `https://headroom.me.uk/api`

**Conventions**

- All requests and responses are JSON (`Content-Type: application/json`).
- Errors are `{ "error": "Human-readable message." }` with an appropriate status. Tier-gated errors add `"upgrade": true` and sometimes `"tier"`.
- **Auth:** endpoints marked 🔒 require a session, via either the `session` cookie (web) or `Authorization: Bearer <token>` (mobile). 🔒👑 additionally requires `is_admin`. 🔒⭐ additionally requires full access (tier 'full' or 'early_adopter', the early_adopter flag, or admin).
- **Rate limits:** 🐢 marks endpoints on the strict auth limiter (15 / 15 min / IP). Everything under /api/ shares the general limit (120 / min / IP). 429 body: `{ "error": "Too many attempts..." }`.
- Timestamps are ISO 8601 with timezone (PostgreSQL TIMESTAMPTZ serialised by JSON).

### 8.1 Auth (/api/auth)

#### POST /api/auth/register 🐢
Create an account. Tier assignment is config-driven (`signup_mode`). Registration consent is logged with IP.

Request:
```json
{
  "email": "user@example.com",        // required, validated format
  "password": "atleast8chars",        // required, min 8 chars
  "displayName": "Dave",              // optional
  "timezone": "Europe/London"         // optional, defaults to Europe/London
}
```
Headers: `X-Client: mobile` to receive the session token in the body.

Response `201`:
```json
{
  "user": {
    "id": 42,
    "email": "user@example.com",
    "displayName": "Dave",
    "tier": "full",
    "earlyAdopter": true,
    "isAdmin": false,
    "timezone": "Europe/London",
    "onboarded": false
  },
  "token": "hex..."   // ONLY when X-Client: mobile; otherwise a session cookie is set
}
```
Errors: `400` missing/invalid email or password; `409` email already registered; `429`; `500`.

#### POST /api/auth/login 🐢
Request: `{ "email": "...", "password": "..." }`. Header `X-Client: mobile` as above.

Response `200`: same shape as register (`user`, plus `token` for mobile). Updates `last_active_at`.
Errors: `400` missing fields; `401` `Invalid email or password.` (same message whether the email exists or not); `429`; `500`.

#### POST /api/auth/logout
Deletes the session identified by the `session` cookie or bearer token, whichever is presented. Clears the cookie only when the token came from the cookie. Response `200 { "ok": true }`.

#### GET /api/auth/me 🔒
Returns the authenticated user. Response `200 { "user": { ...same shape as register } }`. `401` if no/expired session.

#### PUT /api/auth/password 🔒
Change password while logged in.
Request: `{ "currentPassword": "...", "newPassword": "..." }` (new: min 8 chars).
Response `200 { "ok": true }`. Deletes all *other* sessions (identified by the cookie or bearer token, whichever is presented), leaving the caller's own session intact.
Errors: `400` missing/short; `401` wrong current password.

#### PUT /api/auth/profile 🔒
Request (at least one field): `{ "displayName": "New Name", "timezone": "Europe/Paris" }`. `displayName` may be set to empty/null. Response `200 { "ok": true }`; `400` if nothing to update.

#### POST /api/auth/forgot-password 🐢
Request: `{ "email": "..." }`.
Response is always `200 { "ok": true }` (no account enumeration). If the account exists, a reset link is emailed (token valid 1 hour, single use).
Errors: `400` missing email; `429`; `500`.

#### POST /api/auth/reset-password 🐢
Request: `{ "token": "<raw token from email link>", "newPassword": "..." }`.
Response `200 { "ok": true }`. Marks the token used and deletes **all** sessions for the user.
Errors: `400` missing fields, short password, or `Invalid or expired reset link.`

### 8.2 Onboarding (/api/onboarding)

#### GET /api/onboarding/starters
No auth (UI prefetches). Returns suggested starter items:
```json
{
  "fillers":  [ { "label": "Work pressure", "defaultValue": 12 }, ... ],
  "emptiers": [ { "label": "Exercise",      "defaultValue": 14 }, ... ]
}
```

#### POST /api/onboarding/complete 🔒
One-time. Creates the user's initial items and stamps `onboarded_at`.
Request:
```json
{ "items": [ { "label": "Work pressure", "type": "filler", "defaultValue": 12 }, ... ] }
```
Rules: at least one `filler` AND one `emptier`; labels non-empty, ≤60 chars; `defaultValue` a number 1 to 50; `type` in {filler, emptier}.
Response `200 { "ok": true, "itemCount": 7 }`.
Errors: `400` already onboarded, or any validation failure.

### 8.3 Items (/api/items) 🔒 (all)

#### GET /api/items
Active items ordered by type, then sort_order. Note: raw snake_case rows.
```json
{ "items": [ { "id": 1, "label": "Work pressure", "type": "filler", "default_value": 12, "sort_order": 1, "active": true } ] }
```

#### POST /api/items
Request: `{ "label": "...", "type": "filler"|"emptier", "defaultValue": 1-50 }`.
Free tier: capped at `max_items_free` active items → `403 { "error": "...", "upgrade": true }`.
Response `201 { "item": { ...snake_case row } }`. Sort order is appended per type.

#### PUT /api/items/:id
Request (any subset): `{ "label": "...", "defaultValue": 1-50, "sortOrder": 3 }`.
Response `200 { "ok": true }`. `404` if not owned; `400` if nothing to update or validation fails.

#### DELETE /api/items/:id
Soft delete (`active = false`); history remains intact. Response `200 { "ok": true }`; `404` if not found/already inactive.

#### PUT /api/items/reorder/batch
Request: `{ "orders": [ { "id": 1, "sortOrder": 2 }, ... ] }`. Response `200 { "ok": true }`.

### 8.4 Entries (/api/entries) 🔒 (all)

#### POST /api/entries
Log an item tap. The server computes the new level: `clamp(currentLevel + delta, 0, 100)` where `delta = +value` for fillers and `-value` for emptiers, and `value` defaults to the item's `default_value`.
Request: `{ "itemId": 1, "value": 12 }` (`value` optional).
Response `201`:
```json
{
  "entry": { "id": 99, "itemId": 1, "label": "Work pressure", "type": "filler", "value": 12, "levelAfter": 34, "loggedAt": "..." },
  "level": 34
}
```
Errors: `400` no itemId; `404` item not found/inactive/not owned.

#### GET /api/entries?days=7&limit=500
History (default 7 days, limit 500) with item labels, newest first. Free tier: `days` is capped at `max_history_days_free`. Response includes the effective `days`:
```json
{ "entries": [ { "id": 99, "itemId": 1, "label": "Work pressure", "type": "filler", "value": 12, "levelAfter": 34, "loggedAt": "..." } ], "days": 7 }
```

#### GET /api/entries/today
Entries for "today" in the user's timezone, oldest first (drives the main bucket view). Response: `{ "entries": [ ...same shape ] }`.

#### DELETE /api/entries/:id
Deletes an entry and **recalculates `level_after` for every subsequent entry** (re-clamping 0-100 at each step). Response `200 { "ok": true, "level": <new current level> }`. `404` if not owned.

### 8.5 Bucket (/api/bucket) 🔒

#### GET /api/bucket
Current state. `level` is the `level_after` of the latest entry ever (no midnight reset), 0 if none.
```json
{ "level": 34, "headroom": 66, "word": "settled" }
```
Level words: ≤20 calm, ≤40 settled, ≤55 building, ≤70 elevated, ≤85 high, >85 critical.

### 8.6 Share links (/api/share)

#### POST /api/share 🔒⭐
Create a share link (max 10 active per user).
Request: `{ "label": "For my therapist", "settings": { "showChart": true, "showLog": true, "showItemLabels": false } }` (all optional; label defaults to "Shared view", ≤60 chars; settings default true).
Response `201`:
```json
{ "share": { "id": 3, "token": "hex...", "label": "For my therapist", "settings": {...}, "url": "https://headroom.me.uk/#/shared/<token>", "createdAt": "...", "active": true } }
```
`403` (with `upgrade: true`) without full access; `400` at the 10-link cap.

#### GET /api/share 🔒
All of the caller's share links (including revoked), newest first: `{ "shares": [ { ..., "revokedAt": null, "active": true } ] }`.

#### PUT /api/share/:id 🔒
Update label and/or settings of an active link. `404` if not found or revoked.

#### DELETE /api/share/:id 🔒
Revoke (sets `revoked_at`; row retained). `404` if not found or already revoked.

#### GET /api/share/view/:token  (public, no auth)
The read-only shared view consumed by the `/#/shared/<token>` page:
```json
{
  "displayName": "Dave",            // or "Anonymous"
  "shareLabel": "For my therapist",
  "settings": { "showChart": true, "showLog": true, "showItemLabels": false },
  "level": 34, "headroom": 66, "word": "settled",
  "entries": [ { "id": 99, "label": "Load", "type": "filler", "value": 12, "levelAfter": 34, "loggedAt": "..." } ]
}
```
Entries cover the last 7 days (max 200) and are only included if `showChart` or `showLog` is enabled. With `showItemLabels: false`, labels are replaced by "Load"/"Relief". `404` for unknown or revoked tokens.

### 8.7 Patterns (/api/patterns) 🔒⭐

#### GET /api/patterns?days=30
Analytics over the period (default 30, max 365), computed in the user's timezone:
```json
{
  "period": 30,
  "summary": { "totalEntries": 210, "activeDays": 26, "avgLevel": 41, "peakLevel": 88 },
  "topFillers":  [ { "label": "Work pressure", "count": 31, "totalImpact": 372 } ],
  "topEmptiers": [ { "label": "Exercise", "count": 18, "totalRelief": 252 } ],
  "byHour":      [ { "hour": 9, "avgLevel": 47, "entries": 40 } ],
  "byDayOfWeek": [ { "day": "Monday", "dow": 1, "avgLevel": 52, "entries": 35 } ],
  "dailyPeaks":  [ { "day": "2026-08-01", "peak": 71, "low": 22, "entries": 9 } ],
  "longestFillerRun": 6
}
```
`longestFillerRun` is the longest consecutive run of load entries with no relief entry in between. `403` without full access.

### 8.8 Account (/api/me) 🔒 (all)

#### GET /api/me/export
GDPR subject-access export. Returns all user data as a downloadable JSON attachment (`Content-Disposition: attachment; filename="headroom-export-<id>.json"`) containing `user`, `items`, `entries`, `shareTokens`, `consentLog`, and `exportedAt`. The export itself is recorded in the consent log.

#### DELETE /api/me
Permanent self-service account deletion.
Request: `{ "confirmation": "DELETE MY ACCOUNT" }` (exact string required).
Behaviour: logs deletion consent, nullifies `donations.user_id` (financial records retained), deletes the user (cascades to items, entries, sessions, shares, consents, password_resets), clears the session cookie.
Response `200 { "ok": true, "message": "Account and all data permanently deleted." }`.
`400` if the confirmation string is wrong, or if the caller is an admin (admins must use the admin panel).

### 8.9 Admin (/api/admin) 🔒👑 (all)

| Endpoint | Purpose |
|---|---|
| GET /config | All config key-values: `{ "config": { key: value } }` |
| PUT /config | `{ "updates": { key: value, ... } }` upsert (values JSON-encoded) |
| GET /users?search=&limit=&offset= | Paged user list (limit ≤200) with entry/share counts and `total` |
| PUT /users/:id/tier | `{ "tier": "free"\|"full"\|"early_adopter" }` |
| GET /users/:id/data | Full subject-access view of one user (raw rows) |
| DELETE /users/:id | GDPR erasure; blocks self-deletion; nullifies donations |
| GET /partner-codes | List partner codes |
| POST /partner-codes | `{ code, label, tierAssignment?, maxUses?, expiresAt? }`; `409` on duplicate code |
| GET /donations | Last 100 donations + `totalGBP` (pence) |
| GET /stats | `{ totalUsers, totalEntries, activeToday, activeThisWeek }` |

### 8.10 Status code summary

| Code | Meaning here |
|---|---|
| 200 / 201 | Success / resource created |
| 400 | Validation failure, malformed input, business-rule violation |
| 401 | Not authenticated, expired session, or bad credentials |
| 403 | Authenticated but not allowed (tier or admin), body may include `upgrade: true` |
| 404 | Resource not found or not owned by the caller (also API path not found) |
| 409 | Conflict (duplicate email, duplicate partner code) |
| 429 | Rate limited |
| 500 | Unexpected server error (details logged server-side, generic message returned) |

## 9. Mobile client integration guide (Flutter, Phase 1)

1. Send `X-Client: mobile` on `POST /auth/register` and `POST /auth/login`; read `token` from the body and store it with flutter_secure_storage.
2. Attach `Authorization: Bearer <token>` to every request (dio interceptor). On a 401, clear the stored token and route to login.
3. Sessions last 30 days with no refresh mechanism; a 401 mid-session means re-login. (A token-refresh endpoint is a possible Phase 3 enhancement.)
4. Password reset: the emailed link points at the web app (`/reset-password?token=...`). For the mobile app, either open it in a browser or register an app deep link for that URL and call `POST /auth/reset-password` natively.
5. Respect tier signals: `403` bodies with `upgrade: true` should render an upgrade prompt, and `GET /entries` returns the effective `days` after capping.
6. Fix the two bearer-token gaps (logout, password change) in the backend before shipping: see section 4.6.
7. The general rate limit (120/min/IP) is generous but batch where sensible; avoid polling `GET /bucket` more than once per foreground resume.

## 10. Document maintenance

This file is the canonical technical reference. Keep it in the repo (suggested: `docs/HEADROOM-DOCUMENTATION.md`) and update it in the same commit as any API change. Claude Code can be instructed to do this automatically: add a line to the repo's CLAUDE.md such as "Any change to routes/, middleware/, or migrations/ must be reflected in docs/HEADROOM-DOCUMENTATION.md in the same commit."
