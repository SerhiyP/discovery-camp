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
- `api/cron/mc-reminder.ts` — Vercel Cron job, protected by `CRON_SECRET`. Reminds checked-in visitors who haven't registered for the upcoming masterclass slot. Two schedules in `vercel.json` (`0 8 * * *` and `0 10 * * *` UTC = 11:00/13:00 Kyiv in summer), each passing a `?before=12:00`/`?before=14:00` query param matched against the slot's start time. Hobby-plan cron jobs fire sometime within the scheduled hour (never earlier), so this is a "no earlier than" reminder, not exact-time.

### Source modules (`src/`)

| File | Responsibility |
|---|---|
| `bot.ts` | All grammY command/callback handlers; the single `Bot` instance |
| `config.ts` | Env-var loading with required() guard; `todayISO()` and `nowStamp()` helpers (Kyiv timezone) |
| `sheets.ts` | Thin Google Sheets API wrapper: `getRows`, `updateCell`, `appendRow`, `headerIndex` |
| `checkin.ts` | Visitor search, name normalization, row-linking, check-in write, team video lookup |
| `masterclasses.ts` | Masterclass catalog, per-day/slot schedule, and registration CRUD (`EventRegs` tab); `buildSlotButtons` builds the per-slot registration keyboard shared by `/mc` and the reminder cron |
| `responsible.ts` | Responsible-person CRUD, search, and linking (mirrors `leaders.ts`) |
| `messages.ts` | All user-facing Ukrainian strings in one `M` object; also exports `roleCapabilitiesText()` for composing role-based capability messages |
| `keyboards.ts` | Role-composed persistent reply keyboard (`roleKeyboard(opts)`, `BTN`) |
| `admins.ts` | Admin CRUD and `isAdmin` check (Admins sheet + ADMIN_IDS env var) |
| `leaders.ts` | Leader CRUD, search, and linking |
| `commands.ts` | Scoped Telegram command menus per role |
| `phishing.ts` | Phishing-awareness training: `logCatch`/`loadCatches` against the `PhishCatches` tab |

### Google Sheets schema

All state lives in one spreadsheet (`SHEET_ID`). Tabs:

- **`RESPONSES_TAB`** (default: `Form Responses 1`) — Google Form responses; bot adds `Checked in` and `Telegram ID` columns to the right. Also reads `Команда` (team ID) and `Кімната` (room number) columns.
- **`MCSchedule`** — one tab, two independent blocks side by side (fetched once via `loadMCTabRows` and parsed by both loaders). Left: schedule `Date | Slot | MC IDs` (date `YYYY-MM-DD`, slot shown verbatim, MC IDs comma-separated catalog `№` values). Keep `Slot` short (e.g. `12:00-13:00`) — it is embedded in button callback data (64-byte Telegram limit). Right: catalog `№ | Назва | Відповідальний | Місце проведення | Подарунки | Кількість учасників` (extra columns like `посилання на мапу` are ignored). The catalog header row is detected by `Місце проведення`; the title column falls back to `№`+1 because `E1:F1` are merged in the sheet (so `Назва` may be unreadable via the API). `№` like `1.` → ID `1`; capacity `без обмежень`/blank = unlimited; non-numeric-`№` rows are skipped.
- **`EventRegs`** — `Date | Slot | MC ID | Telegram ID | Name | Registered at | Cancelled at` (bot-managed masterclass registrations; one active registration per user per date+slot).
- **`MCResponsible`** — `MC ID | Name | Telegram ID | Added at` (bot-managed via `/addresp` or bulk-imported via `/syncresp`, which reads the catalog's `Відповідальний` column and splits multi-name cells on "і"/"й"/"та"/comma; linked at check-in by name like leaders). Removed via `/delresp`'s button picker, not by typed name.
- **`Videos`** — `ID | Team | File ID | Type` for per-team leader videos. `ID` is a permanent numeric key; `Team` is a display name that can be renamed. `Type` is `video_note` or `video`.
- **`Admins`** — `Telegram ID | Name` (bot-managed via `/addadmin`).
- **`Leaders`** — `Team | Name | Telegram ID | Linked at` (bot-managed via `/addleader`). The `Team` column stores the **numeric ID** matching the `Videos.ID` column.
- **`PhishCatches`** — `Telegram ID | Caught at` — append-only click log for the phishing-awareness training exercise. Written by `/start caught` (deep link), read by `/caught`.

### Role system

Four tiers, checked in order:

1. **Superadmin** — Telegram IDs in `ADMIN_IDS` env var. Full access.
2. **Admin** — rows in the `Admins` sheet. Can manage leaders and broadcast.
3. **Leader** — rows in the `Leaders` sheet. Can notify team, rename team, set team video.
4. **Responsible** — rows in the `MCResponsible` sheet. Can view and message their masterclass attendees, and reveal same-day phishing-training catches via `/caught` (typed-only, no menu entry — same precedent as `/notifymc`). Independent of the leader role; a person can hold both, but each role must be claimed through its own command (`/leader`, `/responsible`) — the bot never offers them together.

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
- **Name search** (`checkin.ts:searchByName`) normalizes apostrophes/case and matches each query word as a prefix against any name word — order-independent, returns top 5. Only the Visitors sheet is searched this way — leader and responsible linking is command-gated behind `/leader <ПІБ>` and `/responsible <ПІБ>` so a typed name can never surface someone else's role.
- **Videos lookup**: keyed by `Videos.ID` (exact string match). The `Leaders.team` column must store the numeric ID (e.g. `1`), not the display name. `updateTeamVideo` returns `false` if the ID isn't found.
- **video_note vs video**: `Videos.Type` column holds `video_note` or `video`. Bot uses `replyWithVideoNote` or `replyWithVideo` accordingly.
- **Video file_id discovery**: admin or leader sends a video/video_note to the bot → superadmin/admin gets the `file_id` echoed; leader gets their team video updated automatically.
- **bot.hears() order**: keyboard button handlers are registered before `bot.on("message:text")` so button text doesn't fall through to name search.
- **Masterclass list is one message per day**, not one per slot: a single `InlineKeyboard` with inert `mcnoop` header rows (`— 12:00-13:00 —`) separating each slot's masterclass buttons. Spots-left is shown on the button; place is shown in the registration confirmation instead. The keyboard is a point-in-time snapshot — it doesn't live-update after someone (else) registers.
- **Admin delete-by-name commands prefer button pickers over typed exact names** — see `/delresp` (`src/bot.ts`): lists candidates as buttons grouped by category, with a confirm step before the actual delete. Apply the same shape if `/removeleader`/`/removeadmin` are revisited.
- **No global `bot.catch`**: an uncaught handler error becomes an HTTP 500, which Telegram retries as the same update. Handlers whose reply could exceed Telegram's ~4096-char message limit at scale (e.g. `/syncresp`'s per-name report) should chunk their output (see `replyChunked` in `src/bot.ts`) rather than risk this.
- Check-in sends a short role-capability follow-up message after the confirmation; `/help` shows the same info on demand.
