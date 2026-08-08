# Web Admin Panel — Design Spec

**Date:** 2026-08-07
**Status:** Approved design. The 2026 camp has ended (as of 2026-08-08), so the build
can start; both this and the help-desk spec target the next camp.
**Estimate:** ~10–14 working days (~2–3 calendar weeks part-time).

## Goal

Move camp administration off Google Sheets + Telegram admin commands onto a dedicated
web page at `/admin`, hosted on the **same Vercel project** as the bot. Admins log in
with their Telegram account, see live statistics, and perform admin actions in a UI
instead of typing bot commands or editing spreadsheet tabs.

## Scope

In scope:

1. **Stats dashboard** — the `/stats` data as a live page.
2. **Admin actions** — role CRUD, sync triggers, check-in release, broadcast.
3. **MC catalog/schedule editing** — replaces the `MCSchedule` sheet tab entirely.

Out of scope (stays as-is):

- The Google Form → `Form Responses 1` visitor intake.
- Payment status editing (the financist keeps editing the sheet by hand; the bot keeps
  its live re-read on the payment gate).
- Visitor row editing (the sheet remains the visitor source of truth; the web shows the
  Mongo mirror read-only apart from check-in release).
- Leader/responsible self-service views (they keep using the bot).

## Key decisions (made 2026-08-07)

| Decision | Choice |
|---|---|
| Hosting | Same Vercel project as the bot |
| UI stack | Next.js (App Router) — the repo converts from bare serverless functions |
| Auth | Telegram Login Widget, gated by the existing admin list |
| MC data source of truth | **Mongo**. Web edits write Mongo directly; `/syncmc` and the `MCSchedule` tab are retired |
| Timeline | Build after the 2026 camp ends |

## Architecture

### Next.js conversion, logic untouched

The repo becomes a Next.js App Router project on the same Vercel project:

- `api/bot.ts` → `app/api/bot/route.ts` using grammY's `webhookCallback` std/http
  adapter. `export const maxDuration = 60` replaces the `vercel.json` function entry
  (the `/broadcast` budget).
- `api/phish.ts` → `app/api/phish/route.ts` (GET renders the page, POST counts the
  beacon — unchanged).
- `api/cron/mc-reminder.ts` → `app/api/cron/mc-reminder/route.ts`; the `crons` entry in
  `vercel.json` stays.
- Everything in `src/` is imported as-is by both the bot route and the admin API.
  **No bot behavior changes in the conversion step.**
- The admin panel is server-rendered pages under `app/admin/` plus a thin JSON API under
  `app/api/admin/*` calling the same `src/` modules the bot uses (`mc-store`,
  `visitor-store`, `admins`, `leaders`, `responsible`, `broadcast`). No logic duplicated.

Deployment notes:

- The Vercel project currently uses the **"Other"** framework preset — switch it to
  **Next.js** when converting.
- Re-run `npm run set-webhook` after the first converted deploy (webhook URL path may
  change).
- All existing env vars carry over; new ones: a session-signing secret.

### Auth — Telegram Login Widget

- `/admin/login` embeds the widget. The callback verifies Telegram's HMAC signature
  (keyed by the bot token), then checks the Telegram ID against the **same admin check
  the bot uses**: `ADMIN_IDS` env var = superadmin, `Admins` sheet = admin.
- On success: signed session cookie (~24h) holding the Telegram ID and tier.
- Middleware guards every `/admin` route: valid cookie **and** a fresh admin-list check,
  so removing someone from `Admins` locks them out on their next request. One access
  list for bot and web.
- One-time setup: `/setdomain` in BotFather so the widget accepts the panel's domain.

## Features

1. **Dashboard** — visitors / checked-in / missing-doctor / missing-payment counts, MC
   registrations per date and slot with capacity bars, both phishing channels (deduped
   Telegram catches, raw QR scan count), and open help-desk requests per category from
   `helpRequests` (see the 2026-08-08 communication help-desk spec). Charts where they
   help.
2. **Visitors** — searchable table over the Mongo mirror (`getVisitorsMongo`): check-in
   state, doctor, payment, team, room. Per-row **release check-in** button (web
   equivalent of `/fixcheckin`, calling `releaseCheckInMongo`; `doctorStatus` is kept,
   same as the bot). Buttons to trigger `/syncvisitors` and `/syncschedule`.
3. **Roles** — add/remove admins, leaders, responsible people via forms and button
   pickers (same UX principle as `/delresp`: pick from a list, confirm, never type an
   exact name). Writes go to the same sheet tabs the bot commands write today, so the
   bot's role checks keep working unchanged. This page also manages the doctor list
   (the `Doctors` sheet tab introduced by the 2026-08-08 communication help-desk spec),
   same add/remove UX as the other roles.
4. **MC management** — create/edit/delete catalog entries (title, responsible, place,
   gifts, capacity), assign MC IDs to date+slot schedule rows, edit per-day topics —
   all **writing directly to Mongo** (`masterclasses`, `mcSchedule`, `mcTopics`).
   Capacity edits reconcile `mcSeats` against active registrations using the same
   rebuild logic `/syncmc` uses today. `/syncmc`, `loadMCTabRows`, the three
   `MCSchedule` parsers, and the tab itself are retired once this ships.
5. **Broadcast composer** — textarea with formatting, preview, recipient count
   (checked-in visitors from Mongo), and a confirm step; sends through the existing
   chunked sender inside the 60s route budget.
6. **Audit log** — every admin write action appends one Mongo doc (`who`, `action`,
   `payload`, `at`) to a new `auditLog` collection. Read-only viewer page, newest first.

## Error handling

- Every Mongo-backed admin route wraps its handler the same way `mongoGuarded` does in
  the bot: an outage returns a friendly retryable error, never an unhandled 500.
- Sheet-writing role routes surface Sheets API errors (quota, permission) verbatim to
  the admin — they are the person who can act on them.
- Auth failures render the login page, never a bare 401.

## Testing

- No test framework exists in the repo; manual verification stays the norm.
- The conversion step is verified by exercising the bot end-to-end against a **test bot
  token + scratch Mongo database + scratch spreadsheet** (same pattern as
  `scripts/dev.ts`) before pointing the production webhook at the converted deploy.
- The MC editor is developed entirely against the scratch Mongo database; it must never
  touch live camp data before camp ends anyway.

## Estimate breakdown

| Piece | Effort |
|---|---|
| Next.js conversion + verify bot/phish/cron still work | 2–3 days |
| Telegram login + session + admin gating | 1 day |
| Dashboard | 1.5–2 days |
| Visitors table + release + sync triggers | 1–1.5 days |
| Role management | 1–1.5 days |
| MC editor incl. seat-counter reconciliation + topic matrix UI | 2–3 days |
| Broadcast + audit log | 1–1.5 days |
| Deploy, BotFather domain, webhook re-registration, shakedown | 1 day |

**Build order:** conversion → auth → dashboard (useful immediately) → visitors/roles →
broadcast/audit → MC editor last, since it changes the MC source of truth.

## Inputs needed at build time

- BotFather access for `/setdomain` (or the owner runs it on request).
- The domain admins will use (`discovery-camp.vercel.app` unless a custom one appears).
- A scratch Mongo database + test bot token for development.