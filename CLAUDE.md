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
| `events.ts` | Event/registration CRUD against the `Events` and `EventRegs` tabs |
| `messages.ts` | All user-facing Ukrainian strings in one `M` object |
| `keyboards.ts` | Role-based persistent reply keyboards (`visitorKeyboard`, `leaderKeyboard`, `BTN`) |
| `admins.ts` | Admin CRUD and `isAdmin` check (Admins sheet + ADMIN_IDS env var) |
| `leaders.ts` | Leader CRUD, search, and linking |
| `commands.ts` | Scoped Telegram command menus per role |

### Google Sheets schema

All state lives in one spreadsheet (`SHEET_ID`). Tabs:

- **`RESPONSES_TAB`** (default: `Form Responses 1`) — Google Form responses; bot adds `Checked in` and `Telegram ID` columns to the right. Also reads `Команда` (team ID) and `Кімната` (room number) columns.
- **`Events`** — `ID | Date | Time | Title | Capacity` (`Capacity=0` = unlimited, `Date` as `YYYY-MM-DD`).
- **`EventRegs`** — `Event ID | Telegram ID | Name | Registered at | Cancelled at` (bot-managed).
- **`Videos`** — `ID | Team | File ID | Type` for per-team leader videos. `ID` is a permanent numeric key; `Team` is a display name that can be renamed. `Type` is `video_note` or `video`.
- **`Admins`** — `Telegram ID | Name` (bot-managed via `/addadmin`).
- **`Leaders`** — `Team | Name | Telegram ID | Linked at` (bot-managed via `/addleader`). The `Team` column stores the **numeric ID** matching the `Videos.ID` column.

### Role system

Three tiers, checked in order:

1. **Superadmin** — Telegram IDs in `ADMIN_IDS` env var. Full access.
2. **Admin** — rows in the `Admins` sheet. Can manage leaders and broadcast.
3. **Leader** — rows in the `Leaders` sheet. Can notify team, rename team, set team video.

### Reply keyboards

Shown automatically after check-in/link; also restored on `/start` for linked users.

| Role | Buttons |
|---|---|
| Visitor | `📅 Події сьогодні` · `🗓 Розклад` · `📋 Мої реєстрації` |
| Leader | Visitor buttons + `📢 Сповістити команду` · `✏️ Перейменувати команду` |

The default Telegram command menu (`Меню` button) is cleared for regular users — admins/superadmins keep scoped command menus.

### Key design notes

- **No database transactions**: concurrent registrations have a small race window — acceptable for camp scale.
- **Row indices are 0-based** (including header row) in `sheets.ts`; cell addresses add 1 when building A1 notation.
- **Name search** (`checkin.ts:searchByName`) normalizes apostrophes/case and matches each query word as a prefix against any name word — order-independent, returns top 5.
- **Videos lookup**: keyed by `Videos.ID` (exact string match). The `Leaders.team` column must store the numeric ID (e.g. `1`), not the display name. `updateTeamVideo` returns `false` if the ID isn't found.
- **video_note vs video**: `Videos.Type` column holds `video_note` or `video`. Bot uses `replyWithVideoNote` or `replyWithVideo` accordingly.
- **Video file_id discovery**: admin or leader sends a video/video_note to the bot → superadmin/admin gets the `file_id` echoed; leader gets their team video updated automatically.
- **bot.hears() order**: keyboard button handlers are registered before `bot.on("message:text")` so button text doesn't fall through to name search.
