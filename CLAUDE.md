# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck        # TypeScript type-check (no emit)
npm run qr               # Generate checkin-qr.png (requires BOT_USERNAME in .env)
npm run set-webhook      # Register Vercel deployment as Telegram webhook
```

There are no tests, but `npm run dev` runs a local long-polling dev server (`scripts/dev.ts`) for manual testing — it loads the same `.env`, so point it at a test bot token and a scratch spreadsheet, not the live camp data. In production the bot runs as a Vercel serverless function. To deploy:

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
| `masterclasses.ts` | Masterclass catalog/schedule/topics parsing from the `MCSchedule` tab, plus the pure helpers (`buildSlotButtons`, `activeRegs`, `topicLines`, ...) shared by handlers and the reminder cron; registrations now live in `mc-store.ts` (Mongo) |
| `responsible.ts` | Responsible-person CRUD, search, and linking (mirrors `leaders.ts`) |
| `messages.ts` | All user-facing Ukrainian strings in one `M` object; also exports `roleCapabilitiesText()` for composing role-based capability messages |
| `keyboards.ts` | Role-composed persistent reply keyboard (`roleKeyboard(opts)`, `BTN`) |
| `admins.ts` | Admin CRUD and `isAdmin` check (Admins sheet + ADMIN_IDS env var) |
| `leaders.ts` | Leader CRUD, search, and linking |
| `commands.ts` | Scoped Telegram command menus per role |
| `phishing.ts` | Phishing-awareness training: `logCatch`/`loadCatches` against the `PhishCatches` tab |
| `mongo.ts` | Serverless-safe shared Mongo client and `COLLECTIONS` |
| `mc-store.ts` | Mongo store for the MC catalog/schedule/topics, registrations with atomic seat counters, camp-schedule cache, and the sync functions |
| `visitor-store.ts` | Scoped visitors mirror for telegramId lookups (sync, lookup with Sheets fallback, check-in write-through) |

### Google Sheets schema

All state lives in one spreadsheet (`SHEET_ID`). Tabs:

- **`RESPONSES_TAB`** (default: `Form Responses 1`) — Google Form responses; bot adds `Checked in` and `Telegram ID` columns to the right. Also reads `Команда` (team ID), `Кімната` (room number) and `Особливі потреби` (allergies/medical notes) columns.
- **`MCSchedule`** — one tab, two independent blocks side by side (fetched once via `loadMCTabRows` and parsed by both loaders). Left: schedule `Date | Slot | MC IDs` (date `YYYY-MM-DD`, slot shown verbatim, MC IDs comma-separated catalog `№` values). Keep `Slot` short (e.g. `12:00-13:00`) — it is embedded in button callback data (64-byte Telegram limit). Right: catalog `№ | Назва | Відповідальний | Місце проведення | Подарунки | Кількість учасників` (extra columns like `посилання на мапу` are ignored). The catalog header row is detected by `Місце проведення`; the title column falls back to `№`+1 because `E1:F1` are merged in the sheet (so `Назва` may be unreadable via the API). `№` like `1.` → ID `1`; capacity `без обмежень`/blank = unlimited; non-numeric-`№` rows are skipped.
- **`EventRegs`** — retired. Registrations live in MongoDB (`registrations` collection);
  this tab is no longer read or written. Left in place so pre-Mongo rows stay readable.
- **`MCResponsible`** — `MC ID | Name | Telegram ID | Added at` (bot-managed via `/addresp` or bulk-imported via `/syncresp`, which reads the catalog's `Відповідальний` column and splits multi-name cells on "і"/"й"/"та"/comma; linked by the person running `/responsible <ПІБ>`, not by typing a name at check-in). Removed via `/delresp`'s button picker, not by typed name.
- **`Videos`** — `ID | Team | File ID | Type` for per-team leader videos. `ID` is a permanent numeric key; `Team` is a display name that can be renamed. `Type` is `video_note` or `video`.
- **`Admins`** — `Telegram ID | Name` (bot-managed via `/addadmin`).
- **`Leaders`** — `Team | Name | Telegram ID | Linked at` (bot-managed via `/addleader`). The `Team` column stores the **numeric ID** matching the `Videos.ID` column.
- **`PhishCatches`** — `Telegram ID | Caught at` — append-only click log for the phishing-awareness training exercise. Written by `/start caught` (deep link), read by `/caught`.

### Role system

Four tiers, checked in order:

1. **Superadmin** — Telegram IDs in `ADMIN_IDS` env var. Full access.
2. **Admin** — rows in the `Admins` sheet. Can manage leaders and broadcast.
3. **Leader** — rows in the `Leaders` sheet. Can view their team roster (name + age + room + special needs) and their team's masterclass registrations for today, notify team, rename team, set team video.
4. **Responsible** — rows in the `MCResponsible` sheet. Can view and message their masterclass attendees, and reveal same-day phishing-training catches via `/caught` (typed-only, no menu entry — same precedent as `/notifymc`). Independent of the leader role; a person can hold both, but each role must be claimed through its own command (`/leader`, `/responsible`) — the bot never offers them together.

### Reply keyboards

Shown automatically after check-in/link; also restored on `/start` for linked users.

| Role | Buttons |
|---|---|
| Visitor | `🎨 Майстер-класи` · `🗓 Розклад` · `📋 Мої реєстрації` |
| Leader | Visitor buttons + `👥 Моя команда` · `🎨 МК команди` · `📢 Сповістити команду` · `✏️ Перейменувати команду` |
| Responsible | Visitor buttons + `👥 Учасники МК` · `📣 Сповістити учасників МК` (stacks with leader rows) |

The default Telegram command menu (`Меню` button) is cleared for regular users — admins/superadmins keep scoped command menus.

### Key design notes

- **Nothing expensive runs at module scope** — `src/bot.ts` is imported afresh on every Vercel cold start, and a check-in rush spins up many lambdas at once, so any import-time work is paid concurrently by all of them while they should be serving webhooks. Command menus used to be rebuilt there (a Sheets read plus one Telegram call per admin and leader); they are Telegram-side persistent state, already updated incrementally on every role change, and are now reconciled by hand via `/syncmenus`.
- **MongoDB is the operational store for masterclasses** (`src/mongo.ts`, `src/mc-store.ts`,
  `src/visitor-store.ts`). The catalog, schedule and topics are imported from `MCSchedule`
  by `/syncmc`; the visitors mirror from the Visitors tab by `/syncvisitors` (telegramId
  lookups only — payment and doctor status are never mirrored, the doctor gate reads Sheets
  live); the camp schedule from the badge grid by `/syncschedule`. Registrations live only
  in Mongo, where a unique partial index on `(date, slot, telegramId)` over `active: true`
  makes one-registration-per-slot a database guarantee, and capacity is an atomic
  per-(date, slot, mcId) seat counter (`mcSeats`) taken with a guarded `$inc` — the
  read-count-append race the sheet version had is gone. `/syncmc` rebuilds the counters
  from active registrations. Check-in write-throughs to the mirror are best-effort. The
  Mongo client is created once per lambda and never at module scope. Every Mongo-backed
  handler goes through `mongoGuarded` (`src/bot.ts`) so an outage replies «спробуйте за
  хвилину» instead of a 500 that Telegram redelivers. `MONGO_URI` unset disables the whole
  MC path and the schedule button (handlers reply «Тимчасова помилка» via `mongoGuarded`);
  `/syncmc` fails loudly. There is no Sheets fallback.
- **`answerCallbackQuery` must never abort a handler** — Telegram invalidates a callback query ~15s after the tap, so it fails routinely under load. Handlers that write to a sheet and then answer would leave the write committed, throw, return HTTP 500 and get redelivered onto a different branch (this is how check-ins were recorded with the QR never sent). All callback handlers answer through `safeAnswer()` (`bot.ts`), which logs instead of throwing, and the toast is never the only way a participant learns the outcome — send a real message too.
- **Sheets reads are quota-bound and auto-batched** — Google allows 60 read *requests* per minute per user, and the service account is one "user" shared by the whole camp. `sheets.ts` collects every `getRows()` issued in the same tick into one `values.batchGet` (one request regardless of range count) and retries a 429 twice with backoff. Nothing is cached, so data is always fresh. The practical rule for handlers: **fetch tabs concurrently, never sequentially** — `await Promise.all([loadA(), loadB()])` costs one request, whereas `await loadA(); await loadB();` costs two. `loadRoleContext()` in `bot.ts` is the shared entry point for "who is this person" (visitor row + leader rows + responsible rows in one request); use it instead of re-loading a tab a handler already has. Bulk operations must never read or write inside a loop — see `addResponsibleMany` (`responsible.ts`), which replaced a per-name read+append in `/syncresp` that exhausted the quota on its own.
- **Row indices are 0-based** (including header row) in `sheets.ts`; cell addresses add 1 when building A1 notation.
- **Name search** (`checkin.ts:searchByName`) normalizes apostrophes/case and matches each query word as a prefix against any name word — order-independent, returns top 5. Only the Visitors sheet is searched this way — leader and responsible linking is command-gated behind `/leader <ПІБ>` and `/responsible <ПІБ>` so a typed name can never surface someone else's role.
- **Videos lookup**: keyed by `Videos.ID` (exact string match). The `Leaders.team` column must store the numeric ID (e.g. `1`), not the display name. `updateTeamVideo` returns `false` if the ID isn't found. When a team is renamed via `/renameteam`, only the `Videos.Team` display column is rewritten (matched by `ID`); visitor and leader team cells hold the stable ID and are never rewritten.
- **video_note vs video**: `Videos.Type` column holds `video_note` or `video`. Bot uses `replyWithVideoNote` or `replyWithVideo` accordingly.
- **Video file_id discovery**: admin or leader sends a video/video_note to the bot → superadmin/admin gets the `file_id` echoed; leader gets their team video updated automatically.
- **bot.hears() order**: keyboard button handlers are registered before `bot.on("message:text")` so button text doesn't fall through to name search.
- **Masterclass list is one message per day**, not one per slot: a single `InlineKeyboard` with inert `mcnoop` header rows (`— 12:00-13:00 —`) separating each slot's masterclass buttons. Spots-left is shown on the button; place is shown in the registration confirmation instead. The keyboard is a point-in-time snapshot — it doesn't live-update after someone (else) registers.
- **Admin delete-by-name commands prefer button pickers over typed exact names** — see `/delresp` (`src/bot.ts`): lists candidates as buttons grouped by category, with a confirm step before the actual delete. Apply the same shape if `/removeleader`/`/removeadmin` are revisited.
- **No global `bot.catch`**: an uncaught handler error becomes an HTTP 500, which Telegram retries as the same update. Handlers whose reply could exceed Telegram's ~4096-char message limit at scale (e.g. `/syncresp`'s per-name report) should chunk their output (see `replyChunked` in `src/bot.ts`) rather than risk this.
- Check-in sends a short role-capability follow-up message after the confirmation; `/help` shows the same info on demand.
- **«Особливі потреби» has two audiences with opposite filtering rules** — the doctor's QR-scan confirmation shows the raw cell always (a missing line would be ambiguous between "nothing to report" and "the bot dropped it"), while the leader roster shows it only when `isMeaningfulNeed()` (`checkin.ts`) rejects it as filler, since a column of `⚠️ Ні` trains leaders to skip the warnings that matter. The filler list matches whole normalized values, never substrings.
- **Leader team views are read-only and button-only** — `👥 Моя команда` and `🎨 МК команди` have no slash-command equivalent and no command-menu entry, because neither takes an argument. The team↔visitor join is `Leaders.Team` against the visitor's `Номер команди` cell (trimmed, case-insensitive); the member↔registration join is the registration's `telegramId` in MongoDB, so a member with no active registration for a given slot (including one who never checked in) reads `без реєстрації`.
- **Reply keyboards are client-side and go stale on role loss** — deleting a row from `Leaders`/`MCResponsible` does not remove the buttons from that person's Telegram; the client keeps the last markup the bot sent. Every role-gated button therefore re-checks the sheet and, when the role is gone, answers via `replyRoleRevoked` (`src/bot.ts`), which attaches the caller's current keyboard (or `remove_keyboard`) so the stale buttons vanish on first press. Any new role-gated button must do the same. The reverse also holds — a role *granted* outside the `/leader`/`/responsible` link flow (typed straight into the sheet, or claimed before reply keyboards existed) sends no markup either, so `/start`, `/help` and a repeat `/leader`/`/responsible` all attach the caller's current keyboard. Telling an existing leader to press `/start` is the supported way to hand out newly added buttons; there is no proactive push.
