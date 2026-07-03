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

- `api/bot.ts` — Telegram webhook handler (POST from Telegram). Wraps `src/bot.ts` via `webhookCallback`. This is the only serverless function (the morning-digest cron was removed).

### Source modules (`src/`)

| File | Responsibility |
|---|---|
| `bot.ts` | All grammY command/callback handlers; the single `Bot` instance |
| `config.ts` | Env-var loading with required() guard; `todayISO()` and `nowStamp()` helpers (Kyiv timezone) |
| `sheets.ts` | Thin Google Sheets API wrapper: `getRows`, `updateCell`, `appendRow`, `headerIndex` |
| `checkin.ts` | Visitor search, name normalization, row-linking, check-in write, team video lookup |
| `masterclasses.ts` | Masterclass catalog, per-day/slot schedule, and registration CRUD (`EventRegs` tab) |
| `responsible.ts` | Responsible-person CRUD, search, and linking (mirrors `leaders.ts`) |
| `messages.ts` | All user-facing Ukrainian strings in one `M` object |
| `keyboards.ts` | Role-based persistent reply keyboards (`visitorKeyboard`, `leaderKeyboard`, `BTN`) |
| `admins.ts` | Admin CRUD and `isAdmin` check (Admins sheet + ADMIN_IDS env var) |
| `leaders.ts` | Leader CRUD, search, and linking |
| `commands.ts` | Scoped Telegram command menus per role |

### Google Sheets schema

All state lives in one spreadsheet (`SHEET_ID`). Tabs:

- **`RESPONSES_TAB`** (default: `Form Responses 1`) — Google Form responses; bot adds `Checked in` and `Telegram ID` columns to the right. Also reads `Команда` (team ID) and `Кімната` (room number) columns.
- **Masterclass catalog** — read-only from the grid spreadsheet (`GRID_SHEET_ID`), tab `5.Майстер-класи 2026`: columns `№ | Назва | Відповідальний | Місце проведення | … | Кількість учасників`. The header row is auto-detected (first row containing `Назва`); `№` like `1.` → ID `1`; capacity `без обмежень`/blank = unlimited; non-numeric-`№` rows (tournament tables) are skipped.
- **`MCSchedule`** — `Date | Slot | MC IDs` (date `YYYY-MM-DD`, slot shown verbatim, MC IDs comma-separated catalog `№` values).
- **`EventRegs`** — `Date | Slot | MC ID | Telegram ID | Name | Registered at | Cancelled at` (bot-managed masterclass registrations; one active registration per user per date+slot).
- **`MCResponsible`** — `MC ID | Name | Telegram ID | Added at` (bot-managed via `/addresp`; linked at check-in by name like leaders).
- **`Videos`** — `ID | Team | File ID | Type` for per-team leader videos. `ID` is a permanent numeric key; `Team` is a display name that can be renamed. `Type` is `video_note` or `video`.
- **`Admins`** — `Telegram ID | Name` (bot-managed via `/addadmin`).
- **`Leaders`** — `Team | Name | Telegram ID | Linked at` (bot-managed via `/addleader`). The `Team` column stores the **numeric ID** matching the `Videos.ID` column.

### Role system

Four tiers, checked in order:

1. **Superadmin** — Telegram IDs in `ADMIN_IDS` env var. Full access.
2. **Admin** — rows in the `Admins` sheet. Can manage leaders and broadcast.
3. **Leader** — rows in the `Leaders` sheet. Can notify team, rename team, set team video.
4. **Responsible** — rows in the `MCResponsible` sheet. Can view and message their masterclass attendees. Independent of the leader role; a person can hold both.

### Reply keyboards

Shown automatically after check-in/link; also restored on `/start` for linked users.

| Role | Buttons |
|---|---|
| Visitor | `🎨 Майстер-класи` · `🗓 Розклад` · `📋 Мої реєстрації` |
| Leader | Visitor buttons + `📢 Сповістити команду` · `✏️ Перейменувати команду` |
| Responsible | Visitor buttons + `👥 Учасники МК` · `📣 Сповістити учасників МК` (stacks with leader rows) |

The default Telegram command menu (`Меню` button) is cleared for regular users — admins/superadmins keep scoped command menus.

### Key design notes

- **No database transactions**: concurrent registrations have a small race window — acceptable for camp scale.
- **Row indices are 0-based** (including header row) in `sheets.ts`; cell addresses add 1 when building A1 notation.
- **Name search** (`checkin.ts:searchByName`) normalizes apostrophes/case and matches each query word as a prefix against any name word — order-independent, returns top 5.
- **Videos lookup**: keyed by `Videos.ID` (exact string match). The `Leaders.team` column must store the numeric ID (e.g. `1`), not the display name. `updateTeamVideo` returns `false` if the ID isn't found.
- **video_note vs video**: `Videos.Type` column holds `video_note` or `video`. Bot uses `replyWithVideoNote` or `replyWithVideo` accordingly.
- **Video file_id discovery**: admin or leader sends a video/video_note to the bot → superadmin/admin gets the `file_id` echoed; leader gets their team video updated automatically.
- **bot.hears() order**: keyboard button handlers are registered before `bot.on("message:text")` so button text doesn't fall through to name search.
