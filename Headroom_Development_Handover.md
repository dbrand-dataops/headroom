# Headroom Development Handover

## What Headroom is

Headroom is a personal psychological load management tool built on the CBT stress-bucket model. Users log persistent stressors (load) and relief actions through the day. The bucket level represents accumulated psychological load. The space between the current level and the top is the headroom, the margin the user maintains so automatic behaviours do not take over. It originated from a conversation between David and a keyworker at Change Grow Live (CGL) Nottingham during addiction recovery.

Live at: https://headroom.me.uk
GitHub: https://github.com/dbrand-dataops/headroom (private)
Render service: headroom web service + headroom-db PostgreSQL (basic-256mb plan)
Domain: headroom.me.uk on Cloudflare (DNS only / grey cloud, CNAME to Render)


## Current state (as of 9 May 2026)

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
- Bucket view with two tabs:
  - **Log tab**: Load/Relief toggle filter (shows one group at a time to reduce scrolling), item rows with intensity buttons (+/++/+++ for load, minus equivalents for relief), inline custom value input, rename and trash icon controls
  - **Overview tab**: today's chart and scrollable entry log with delete buttons
- History: scrollable log with chart, period selector (7/14/30/90 days), entry deletion
- Patterns: top load/relief by entry count (not accumulated weight), day-of-week bar chart, hour-of-day bar chart, summary stats, longest filler run
- Settings: profile, password change, share link management with copy-to-clipboard, customisable visibility toggles (chart/log/item names), data export, logout
- Admin panel: stats, signup mode toggle (launch/freemium/partner), user list with tier override
- Shared view: public read-only bucket for share token holders, respects visibility settings

**Backend API (all under /api/):**
- /api/auth: register, login, logout, me, password change, profile update
- /api/items: CRUD with soft delete, tier-based limits
- /api/onboarding: starter items, completion flow
- /api/entries: create (accepts optional value for intensity), list (with tier day limits), today, delete with level recalculation
- /api/bucket: current level (persists across midnight, no auto-reset)
- /api/share: create with settings, list, update settings, revoke, public view
- /api/patterns: server-side analytics (7 parallel queries), returns count, totalImpact/totalRelief, byHour, byDayOfWeek, dailyPeaks, longestFillerRun, summary stats
- /api/admin: config, users, partner codes, donations, stats
- /api/me: GDPR data export, account deletion
- /api/stripe: NOT YET BUILT (commented out in server.js)


## Recent changes (9 May 2026 session)

### Intensity buttons (replacing fixed values)
The original model assigned a fixed numeric value to each item (e.g. "Conflict +20"). The new model removes fixed values and instead offers three intensity buttons per item when logging:
- + / - = mild (5 points)
- ++ / -- = moderate (12 points)
- +++ / --- = strong (20 points)
- Plus an inline custom number input for arbitrary values (1-100)

The intensity values are defined in a frontend constant: `const INTENSITY = { 1: 5, 2: 12, 3: 20 };`

The frontend sends the unsigned intensity value to `POST /api/entries` as `{ itemId, value }`. The backend's entries.js already handles this: it uses `req.body.value` when provided (line 33: `typeof value === 'number' ? value : item.default_value`), then applies the sign based on item type (filler = positive, emptier = negative).

Items still have a `default_value` column in the database. It is set to 10 when creating new items but is no longer used for logging (only as fallback if no value is sent). Adding items now only requires a label, no value picker.

### Log/Overview tabs on bucket page
The bucket view's right panel now has two tabs:
- **Log**: shows Load/Relief toggle filter and item rows with intensity buttons
- **Overview**: shows today's chart and entry log

Tab selection persists in localStorage (`headroom_tab`). The bucket SVG stays visible on the left regardless of tab.

### Load/Relief filter
Within the Log tab, a toggle at the top switches between showing Load items or Relief items. This halves scrolling for users with many items. Defaults to "Load".

### Item row design
Each item row has a bordered box (`.item-inner`) containing: label, three intensity buttons, inline custom value input, and a small play/go button. Outside the box: a rename button (pencil icon with visible teal border) and a trash can SVG icon for removal.

Custom values persist per-item in a `customVals` state object. The value stays in the input after logging until the user changes it.

### Share link copy button
Each active share link in Settings now has a "Copy" button that copies the URL to clipboard and shows "Copied" for 2 seconds.

### Overview tab chart fix
HistoryChart now renders with 1 entry (previously required 2). This means the overview tab shows the chart as soon as any entry is logged today.
- Bar values now show entry count (not accumulated impact weight)
- Bar labels stack above bars (fixes long labels pushing bars right)
- Top loads and top reliefs sorted by count descending (largest first)
- Day-of-week bar chart with entry counts above each bar, bars coloured by average bucket level (teal/amber/coral thresholds)
- Hour-of-day bar chart, same style as day chart, values above bars, bucket-coloured
- Backend already returned all needed data (count, byHour, byDayOfWeek); frontend was using wrong field names initially, now fixed
- The bucket-level colour function: teal (avg 0-40), amber (40-70), coral (70+)

### Share link bug fix
The `settings` JSONB column was missing from `share_tokens` table. Migration `003-share-settings.sql` adds it. This was causing the 500 error on `POST /api/share`.

### Data migration from old app
The original SQLite-based app (trigger-level.onrender.com, using better-sqlite3) had 286 entries from 17 Apr to 8 May 2026. A SQL migration script (`migrate-data.sql`) was created to import 56 active items and 280 entries into the new PostgreSQL app under user_id=1. Three inactive items were excluded. This should be run in DBeaver against the Render PostgreSQL database.

### Deployment status
As of the end of this session, the following files need to be deployed:
- `migrations/003-share-settings.sql` (share link bug fix)
- `public/index.html` (all frontend changes)
- `migrate-data.sql` (one-time data import, run via DBeaver)

No backend route files were changed. The entries.js and patterns.js already supported all the new functionality.


## Stack

- Node.js 20.x, Express 4.x
- PostgreSQL (Render managed, basic-256mb plan)
- pg (node-postgres) with connection pool
- bcryptjs for password hashing
- cookie-parser for session cookies
- express-rate-limit
- React 18 via CDN (no build step, Babel standalone for JSX)
- Fraunces + DM Sans fonts (Google Fonts)
- Single-file SPA: public/index.html contains all CSS and React components (~1210 lines)
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
    entries.js           Create entry (accepts optional value override), list, today, delete with recalculation, getCurrentLevel
    bucket.js            Current level + headroom + state word
    share.js             Create/list/update/revoke shares, public view with settings
    patterns.js          Server-side analytics (7 parallel queries: topFillers, topEmptiers, byHour, byDayOfWeek, dailyPeaks, longestFillerRun, summary)
    admin.js             Config, users, partner codes, donations, stats
    user.js              GDPR export, account deletion

  public/
    index.html           Full SPA (public site + authenticated app, ~1210 lines)
    manifest.json        PWA manifest, start_url: /
    sw.js                Service worker v4
    icon-192.png         PWA icon (teal bucket on dark bg)
    icon-512.png         PWA icon
    Headroom-CGL-Proposal.pdf  Downloadable proposal document
```


## Database schema (PostgreSQL)

11 tables defined in 001-initial.sql:

- **users**: id, email, password_hash, display_name, tier, is_admin, early_adopter, timezone, stripe_customer_id, onboarded_at, last_active_at, created_at, updated_at
- **items**: id, user_id, label, type (filler/emptier), default_value (legacy, set to 10 for new items, not used for logging since intensity buttons were added), sort_order, active, created_at
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


## Intensity model

Items no longer carry a meaningful fixed value. Instead, users choose intensity at log time:
- Mild (+/-): 5 points
- Moderate (++/--): 12 points
- Strong (+++/---): 20 points
- Custom: any value 1-100, entered in an inline input

The frontend constant `INTENSITY = { 1: 5, 2: 12, 3: 20 }` defines these. The value is sent unsigned to the backend, which applies the sign based on item type.


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

2. **Item value edit intermittent on first use.** Naomi reported editing item values silently failed the first 3 times, then worked. Less relevant now since editing only changes the label (intensity buttons replaced fixed values).

3. **Public content pages missing.** The Why, About, and Contact pages show "Coming soon" after the frontend rebuild. The content was substantial (Why page had 10 sections + 30 references). Needs to be restored into the current index.html SPA.

4. **Demo page still uses old fixed-value items.** The interactive demo (DemoPage component) uses the old model with fixed item values and single-tap logging. Should be updated to match the new intensity button UX.

5. **Onboarding page still shows default_value.** The starter item selection still displays +/- values per item. Should be simplified to just labels since values are chosen at log time via intensity buttons.

6. **Old app (trigger-level.onrender.com) still running.** Can be shut down on Render after data migration is confirmed successful.


## Planned work (priority order)

1. **Restore public content pages** (Why It Works, About, Contact with Resources). Content was built in previous conversation history. The Why page is the pitch-critical page for CGL and funders.

2. **Stripe donations.** One-off payments via Stripe Checkout. "Support Headroom" button. donations table already exists. Config keys for amounts already seeded. Need routes/stripe.js with checkout session creation, webhook handler, and frontend button.

3. **Privacy policy page.** Required for GDPR before wider release. Should be at /#/privacy, linked from footer and registration form.

4. **Stripe subscriptions and tier gating.** For when signup_mode switches to freemium. subscriptions table already exists. Need Stripe webhook handling for subscription lifecycle events.

5. **More onboarding starter items.** Naomi suggested offering a larger pool so users can pick from more options.

6. **Update demo page** to use intensity buttons instead of fixed values.

7. **Update onboarding page** to remove value display from starter items.


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
# edit files directly or copy from downloads
git add -A && git commit -m "description" && git push
```

Files downloaded from Claude go to ~/Downloads/. Copy them into the repo manually before committing:
```bash
cp ~/Downloads/filename.js routes/filename.js  # or wherever it belongs
```

When providing multiple files that share a name but go in different directories (e.g. middleware/auth.js and routes/auth.js), name the downloads distinctly (e.g. middleware-auth.js and routes-auth.js) to avoid overwrite confusion.


## Using Claude Code for development

David has Claude Code installed on his Linux machine. For iterative development, Claude Code is preferred over chat because:
- It can read/edit files directly in the repo at ~/Documents/wip/coding/headroom
- It can run git commands, npm, and test locally
- No file upload/download round trips
- Uses far less context per change

To start a session:
```bash
cd ~/Documents/wip/coding/headroom
claude
```

Then provide this handover document as context (e.g. "read Headroom_Development_Handover.md for project context").


## Documents available

David has these documents which informed the site content:
- Headroom-Handover.docx (original project handover, architecture decisions)
- Headroom-CGL-Proposal.docx (pitch to CGL Nottingham)
- Headroom-Clinical-References.docx (17 verified peer-reviewed references with URLs)
- Headroom-Design-Document.docx (technical design)
- why_headroom_works.md (long-form article on the neuroscience, genetics, and mechanism)
- Three research PDFs (brain imaging biomarkers, neurobiology of addiction, resting-state brain activity)

The CGL proposal is already served as a PDF at /Headroom-CGL-Proposal.pdf.


## Original app (trigger-level.onrender.com)

The original Headroom ran on SQLite (better-sqlite3) with a single-user password-based auth model. Key differences from the new app:
- Single user, no registration
- SQLite on Render persistent disk
- Items had text IDs (e.g. "work", "c1776439784986")
- Entries stored delta (signed) and level (level after)
- Bearer token auth via localStorage (key: bucket_token)
- API: /api/login, /api/status, /api/adjust, /api/history, /api/share (single view token)

Data was exported via browser console API calls and imported to the new PostgreSQL app via migrate-data.sql.
