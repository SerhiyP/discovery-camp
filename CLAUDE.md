# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck        # TypeScript type-check (no emit)
npm run qr               # Generate checkin-qr.png (requires BOT_USERNAME in .env)
npm run set-webhook      # Register Vercel deployment as Telegram webhook
```

There are no tests and no local dev server — the bot runs exclusively as a Vercel serverless function. To deploy:

```bash
npx vercel --prod
```

After deploy, run `npm run set-webhook` to register the new URL with Telegram.

## Architecture

This is a **grammY Telegram bot** deployed on **Vercel serverless** with **Google Sheets as the database**.

### Entry points

- `api/bot.ts` — Telegram webhook handler (POST from Telegram). Wraps `src/bot.ts` via `webhookCallback`.
- `api/cron/digest.ts` — Morning digest cron job, fires at `0 5 * * *` UTC (08:00 Kyiv). Protected by `CRON_SECRET`.

### Source modules (`src/`)

| File | Responsibility |
|---|---|
| `bot.ts` | All grammY command/callback handlers; the single `Bot` instance |
| `config.ts` | Env-var loading with required() guard; `todayISO()` and `nowStamp()` helpers (Kyiv timezone) |
| `sheets.ts` | Thin Google Sheets API wrapper: `getRows`, `updateCell`, `appendRow`, `headerIndex` |
| `checkin.ts` | Visitor search, name normalization, row-linking, check-in write, team video lookup |
| `events.ts` | Event/registration CRUD against the `Events` and `EventRegs` tabs |
| `messages.ts` | All user-facing Ukrainian strings in one `M` object |

### Google Sheets schema

All state lives in one spreadsheet (`SHEET_ID`). Four tabs:

- **`RESPONSES_TAB`** (default: `Form Responses 1`) — Google Form responses; bot adds `Checked in` and `Telegram ID` columns to the right.
- **`Events`** — `ID | Date | Time | Title | Capacity` (`Capacity=0` = unlimited, `Date` as `YYYY-MM-DD`).
- **`EventRegs`** — `Event ID | Telegram ID | Name | Registered at | Cancelled at` (bot-managed).
- **`Videos`** (optional) — `Team | File ID` for per-team leader videos.

### Key design notes

- **No database transactions**: concurrent registrations have a small race window — acceptable for camp scale.
- **Row indices are 0-based** (including header row) in `sheets.ts`; cell addresses add 1 when building A1 notation.
- **Name search** (`checkin.ts:searchByName`) normalizes apostrophes/case and matches each query word as a prefix against any name word — order-independent, returns top 5.
- **Admin check** is done inline in `bot.ts` via `ADMIN_IDS` (comma-separated Telegram user IDs).
- **Video file_id discovery**: admin sends/forwards a video to the bot → bot echoes the `file_id` for pasting into the Videos tab.
