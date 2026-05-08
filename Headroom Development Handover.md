# Headroom Development Handover

## What Headroom is

Headroom is a personal psychological load management tool built on the CBT stress-bucket model. Users log persistent stressors (load) and relief actions through the day. The bucket level represents accumulated psychological load. The space between the current level and the top is the headroom, the margin the user maintains so automatic behaviours do not take over. It originated from a conversation between David and a keyworker at Change Grow Live (CGL) Nottingham during addiction recovery.

Live at: https://headroom.me.uk
GitHub: https://github.com/dbrand-dataops/headroom (private)
Render service: headroom web service + headroom-db PostgreSQL (basic-256mb plan)
Domain: headroom.me.uk on Cloudflare (DNS only / grey cloud, CNAME to Render)


## Current state (as of 8 May 2026)

The app is live with two active users (David and Naomi). Both are registered, onboarded, and using it daily. The public marketing site and the authenticated app run from the same single-page application.

### What is built and deployed

**Public site:**
- Landing page with animated bucket, concept cards, CTA
- Interactive demo (client-side only, no login, pre-seeded data)
- Login and registration pages
- PWA: manifest.json, service worker, icons (installable on mobile)
- Footer links to Contact

**Public content pages NOT currently rendered:**
- Why It Works page (was a substantial page built from why_headroom_works.md + 30 clinical references with clickable URLs, all verified)
- About page (origin story, CGL connection, daily practice, developer bio)
- Contact page (with Resources section, CGL proposal PDF download)
- These pages were dropped when the frontend was rebuilt for the authenticated app. They currently show "Coming soon". The content exists and needs to be restored. The Why page was the most substantial: 10 narrative sections, a supported model statement, and 30 references organised by topic with clickable URLs opening in new tabs.

**Authenticated app (requires login):**
- Onboarding: users choose from starter items (recently fixed to start unselected, tap to include)
- Bucket view: the daily screen with bucket SVG, level reading, item rows with inline edit/delete/add, today's log with entry deletion
- History: scrollable log with chart, period selector (7/14/30/90 days), entry deletion
- Patterns: top load sources, top relief actions as bar charts, summary stats, longest filler run
- Settings: profile, password change, share link management with customisable visibility (chart/log/item names toggles), data export, logout
- Admin panel: stats, signup mode toggle (launch/freemium/partner), user list with tier override
- Shared view: public read-only bucket for share token holders, respects visibility settings

**Backend API (all under /api/):**
- /api/auth: register, login, logout, me, password change, profile update
- /api/items: CRUD with soft delete, tier-based limits
- /api/onboarding: starter items, completion flow
- /api/entries: create, list (with tier day limits), today, delete with level recalculation
- /api/bucket: current level (persists across midnight, no auto-reset)
- /api/share: create with settings, list, update settings, revoke, public view
- /api/patterns: server-side analytics (7 parallel queries)
- /api/admin: config, users, partner codes, donations, stats
- /api/me: GDPR data export, account deletion
- /api/stripe: NOT YET BUILT (commented out in server.js)


## Stack

- Node.js 20.x, Express 4.x
- PostgreSQL (Render managed, basic-256mb plan)
- pg (node-postgres) with connection pool
- bcryptjs for password hashing
- cookie-parser for session cookies
- express-rate-limit
- React 18 via CDN (no build step, Babel standalone for JSX)
- Fraunces + DM Sans fonts (Google Fonts)
- Single-file SPA: public/index.html contains all CSS and React components
- Hash-based client-side routing (#/app, #/login, #/shared/:token, etc.)
- Service worker: network-first for static assets, network-only for API calls


## File structure

```
headroom/
  server.js              Express app, middleware, route mounting, migration on startup
  db.js                  pg pool, query/queryOne/transaction helpers
  migrate.js             SQL migration runner, tracks applied in migrations table
  package.json           bcryptjs, cookie-parser, express, express-rate-limit, pg
  render.yaml            Web service + PostgreSQL database definition

  migrations/
    001-initial.sql      Full schema: 11 tables
    002-config-seed.sql  Default config values (signup_mode, tier limits, consent text)
    003-share-settings.sql  Adds settings JSONB column to share_tokens

  middleware/
    auth.js              requireAuth, optionalAuth (session cookie check)
    admin.js             requireAdmin (is_admin flag check)
    rate-limit.js        authLimiter (15/15min), apiLimiter (120/min)
    tier.js              hasFullAccess, requireFull, getTierLimits (cached)

  routes/
    auth.js              Register, login, logout, me, password, profile
    items.js             CRUD, soft delete, batch reorder, tier item limits
    onboarding.js        Starter items list, completion (creates items, sets onboarded_at)
    entries.js           Create entry, list, today, delete with recalculation, getCurrentLevel
    bucket.js            Current level + headroom + state word
    share.js             Create/list/update/revoke shares, public view with settings
    patterns.js          Server-side analytics (7 parallel queries)
    admin.js             Config, users, partner codes, donations, stats
    user.js              GDPR export, account deletion

  public/
    index.html           Full SPA (public site + authenticated app, ~1040 lines)
    manifest.json        PWA manifest, start_url: /
    sw.js                Service worker v4
    icon-192.png         PWA icon (teal bucket on dark bg)
    icon-512.png         PWA icon
    Headroom-CGL-Proposal.pdf  Downloadable proposal document
```


## Database schema (PostgreSQL)

11 tables defined in 001-initial.sql:

- **users**: id, email, password_hash, display_name, tier, is_admin, early_adopter, timezone, stripe_customer_id, onboarded_at, last_active_at, created_at, updated_at
- **items**: id, user_id, label, type (filler/emptier), default_value, sort_order, active, created_at
- **entries**: id, user_id, item_id, value (signed: positive for fillers, negative for emptiers), level_after (0-100), logged_at
- **sessions**: id, user_id, token, created_at, expires_at (30 days)
- **share_tokens**: id, user_id, token, label, settings (JSONB: showChart, showLog, showItemLabels), created_at, revoked_at
- **password_resets**: id, user_id, token, created_at, used_at
- **consent_log**: id, user_id, consent_type, consent_text, ip_address, created_at
- **donations**: id, user_id (nullable), amount_pence, currency, stripe_payment_id, created_at
- **subscriptions**: id, user_id, stripe_subscription_id, stripe_price_id, status, period start/end, timestamps
- **partner_codes**: id, code, label, tier_assignment, organisation_id, max_uses, use_count, expires_at
- **config**: key (text PK), value (JSONB), updated_at

Key indexes: users(email), entries(user_id, logged_at DESC), sessions(token), share_tokens(token) WHERE revoked_at IS NULL.

Current users:
- David (id: 1, admin, full tier, early adopter, email: davidbrand@logicscience.co.uk)
- Naomi (id: 2, full tier, early adopter)


## Bucket model

The bucket is a trapezoid. Fill height uses the area-correct formula:
```
fillH = (-98 + sqrt(9604 + 11712 * L)) / 0.32
```
where L = level / 100. The fill Y position is `188 - fillH`.

Colour transitions: teal (0-40%), amber (40-70%), coral (70-100%).
State words: calm (0-20), settled (20-40), building (40-55), elevated (55-70), high (70-85), critical (85-100).

The bucket does NOT reset at midnight. Level persists until the user acts. This was a deliberate fix: stressors don't vanish overnight.


## Auth model

- Session-based with httpOnly secure cookies (30 day expiry)
- bcryptjs cost factor 12
- Email normalised to lowercase
- Signup mode (stored in config table) determines what tier new users get:
  - "launch": full tier + early_adopter flag (current mode)
  - "freemium": free tier, upgrade via Stripe
  - "partner": via partner codes
- Early adopter flag permanently grants full access regardless of tier changes
- GDPR: consent logged at registration, data export via /api/me/export, account deletion via DELETE /api/me


## Known issues still outstanding

1. **Password reset not functional.** No email sending is configured. Users cannot reset passwords via email. Would need an email service (e.g. Resend, SendGrid, or SMTP) integrated.

2. **Item value edit intermittent on first use.** Naomi reported editing item values silently failed the first 3 times, then worked. The new controlled-input ItemRow component should fix this, but it needs verification with a fresh user.

3. **Public content pages missing.** The Why, About, and Contact pages show "Coming soon" after the frontend rebuild. The content was substantial (Why page had 10 sections + 30 references). Needs to be restored into the current index.html SPA.


## Planned work (priority order)

1. **Restore public content pages** (Why It Works, About, Contact with Resources). Content was built in this chat and exists in the conversation history. The Why page is the pitch-critical page for CGL and funders.

2. **Stripe donations.** One-off payments via Stripe Checkout. "Support Headroom" button. donations table already exists. Config keys for amounts already seeded. Need routes/stripe.js with checkout session creation, webhook handler, and frontend button.

3. **Privacy policy page.** Required for GDPR before wider release. Should be at /#/privacy, linked from footer and registration form.

4. **Stripe subscriptions and tier gating.** For when signup_mode switches to freemium. subscriptions table already exists. Need Stripe webhook handling for subscription lifecycle events.

5. **More onboarding starter items.** Naomi suggested offering a larger pool so users can pick from more options.


## Important rules for producing content

- NEVER use em dashes. Use commas, periods, colons, or reword instead. This applies to all writing, comments, HTML content, and documentation.
- Contact email: davidbrand@logicscience.co.uk
- David's GitHub: dbrand-dataops
- The app uses pg (node-postgres) which auto-deserializes JSONB columns. Do NOT call JSON.parse() on values read from JSONB columns; they are already JavaScript values. JSON.stringify() IS needed when writing to JSONB columns.


## Deployment process

David works locally on Ubuntu, edits files, commits to GitHub (main branch), and Render auto-deploys on push. Migrations run automatically on startup via migrate.js. The DATABASE_URL env var is set in Render pointing to the PostgreSQL instance.

To deploy changes:
```bash
cd ~/Documents/wip/coding/headroom
# copy/edit files
git add -A && git commit -m "description" && git push
```

Files David downloads go to ~/Downloads/. He copies them into the repo manually:
```bash
cp ~/Downloads/filename.js routes/filename.js  # or wherever it belongs
```

When providing multiple files that share a name but go in different directories (e.g. middleware/auth.js and routes/auth.js), name the downloads distinctly (e.g. middleware-auth.js and routes-auth.js) to avoid overwrite confusion.


## Documents available

David has these documents which informed the site content:
- Headroom-Handover.docx (original project handover, architecture decisions)
- Headroom-CGL-Proposal.docx (pitch to CGL Nottingham)
- Headroom-Clinical-References.docx (17 verified peer-reviewed references with URLs)
- Headroom-Design-Document.docx (technical design)
- why_headroom_works.md (long-form article on the neuroscience, genetics, and mechanism)
- Three research PDFs (brain imaging biomarkers, neurobiology of addiction, resting-state brain activity)

The CGL proposal is already served as a PDF at /Headroom-CGL-Proposal.pdf.
Done

