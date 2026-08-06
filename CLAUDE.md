# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck        # TypeScript type-check (no emit)
npm run qr               # Generate checkin-qr.png (requires BOT_USERNAME in .env)
npm run qr -- <url> <out.png>   # Any other QR (phishing poster, med link, …)
npm run set-webhook      # Register Vercel deployment as Telegram webhook
```

There are no tests, but `npm run dev` runs a local long-polling dev server (`scripts/dev.ts`) for manual testing — it loads the same `.env`, so point it at a test bot token and a scratch spreadsheet, not the live camp data. In production the bot runs as a Vercel serverless function. To deploy:

```bash
npx vercel --prod
```

After deploy, run `npm run set-webhook` to register the new URL with Telegram.

## Architecture

This is a **grammY Telegram bot** deployed on **Vercel serverless**, with two stores:
**Google Sheets** is where humans enter data (the registration form, roles, videos, the
masterclass catalog and schedule), and **MongoDB** is the operational store everything the
bot writes at runtime lives in (check-ins, MC registrations, phishing counters, plus cached
copies of the sheet-side catalog and schedule). Sheets → Mongo is a one-way, admin-triggered
sync (`/syncmc`, `/syncvisitors`, `/syncschedule`); nothing syncs back.

### Entry points

- `api/bot.ts` — Telegram webhook handler (POST from Telegram). Wraps `src/bot.ts` via `webhookCallback`. `maxDuration: 60` in `vercel.json` — `/broadcast` needs it.
- `api/cron/mc-reminder.ts` — Vercel Cron job, protected by `CRON_SECRET`. Reminds checked-in visitors who haven't registered for the upcoming masterclass slot. One schedule in `vercel.json` (`0 10 * * *` UTC = 13:00 Kyiv in summer) passing `?before=14:00`, matched against the slot's *start* time so it survives an end-time change in `MCSchedule`. Add a second entry (e.g. `0 8 * * *` with `?before=12:00`) if a morning slot comes back. Reads Mongo only — no Sheets in this cron. Hobby-plan cron jobs fire sometime within the scheduled hour (never earlier), so this is a "no earlier than" reminder, not exact-time.
- `api/phish.ts` — the direct-HTTP phishing-training page. The poster QR encodes this plain `https://…/api/phish` URL (no Telegram hop), so a scan opens the reveal instantly in the browser. `GET` renders the page; the scan is counted by the `POST` beacon the page's inline script fires, because QR scanners and link previewers prefetch the GET without running JS. Anonymous by design — there is no Telegram ID on this path, only a count.

### Source modules (`src/`)

| File | Responsibility |
|---|---|
| `bot.ts` | All grammY command/callback handlers; the single `Bot` instance |
| `config.ts` | Env-var loading with required() guard; `todayISO()`, `nowStamp()` and `stampTime()` helpers (Kyiv timezone) |
| `sheets.ts` | Thin Google Sheets API wrapper: `getRows`, `getRowsFromSpreadsheet`, `updateCell`, `appendRow`, `headerIndex` |
| `checkin.ts` | Visitor search, name normalization, `isMeaningfulNeed`, team roster helpers, team video lookup. Its `linkAndCheckIn` (sheet write) is superseded by `visitor-store.ts`'s Mongo version — see the check-in note below |
| `schedule.ts` | Camp-day schedule rendering: camp start/end window, "current activity" highlight, day label. Slots come from the Mongo cache (`getCampSlots`) |
| `broadcast.ts` | `broadcastEntities()` — re-bases the admin's own formatting/links onto the text `/broadcast` sends |
| `masterclasses.ts` | Masterclass catalog/schedule/topics parsing from the `MCSchedule` tab, plus the pure helpers (`buildSlotButtons`, `activeRegs`, `topicLines`, ...) shared by handlers and the reminder cron; registrations now live in `mc-store.ts` (Mongo) |
| `responsible.ts` | Responsible-person CRUD, search, and linking (mirrors `leaders.ts`) |
| `messages.ts` | All user-facing Ukrainian strings in one `M` object; also exports `roleCapabilitiesText()` for composing role-based capability messages |
| `keyboards.ts` | Role-composed persistent reply keyboard (`roleKeyboard(opts)`, `BTN`) |
| `admins.ts` | Admin CRUD and `isAdmin` check (Admins sheet + ADMIN_IDS env var) |
| `leaders.ts` | Leader CRUD, search, and linking |
| `commands.ts` | Scoped Telegram command menus per role |
| `phishing.ts` | Phishing-awareness training, both channels, in Mongo: `logCatch`/`loadCatches` (Telegram deep link, per-person) and `logScan`/`loadScans` (QR → `api/phish`, anonymous count) |
| `mongo.ts` | Serverless-safe shared Mongo client and `COLLECTIONS` |
| `mc-store.ts` | Mongo store for the MC catalog/schedule/topics, registrations with atomic seat counters, camp-schedule cache, and the sync functions |
| `visitor-store.ts` | Visitors mirror: sync from Sheets, telegramId/row lookups, the check-in link/release writes, doctor-exam mark and payment refresh |

### Google Sheets schema

All state lives in one spreadsheet (`SHEET_ID`). Tabs:

- **`RESPONSES_TAB`** (default: `Form Responses 1`) — Google Form responses. Column headers are all in `config.ts` (`nameHeader`, `age`, `paymentStatusHeader` «Статус оплати», `doctorStatusHeader` «Лікар», `roomHeader`, `teamHeader`, `specialNeedsHeader`) — change them there, nowhere else. The `Checked in` and `Telegram ID` columns still have to exist (`loadVisitors` throws without them) but **nothing writes them any more**: since 2026-08-03 the link is written to Mongo instead, so those cells only hold pre-migration values. Payment status is edited in the sheet by hand (by the financist) and is the one field read live during check-in.
- **`MCSchedule`** — one tab, three independent blocks (fetched once via `loadMCTabRows` and parsed by all three loaders):
  - schedule `Date | Slot | MC IDs`, columns A-C (date `YYYY-MM-DD`, slot shown verbatim, MC IDs comma-separated catalog `№` values). Keep `Slot` short (e.g. `12:00-13:00`) — it is embedded in button callback data (64-byte Telegram limit).
  - catalog, to the right: `№ | Назва | Відповідальний | Місце проведення | Подарунки | Кількість учасників` (extra columns like `посилання на мапу` are ignored). Header row detected by `Місце проведення`; the title column falls back to `№`+1 because `E1:F1` are merged in the sheet (so `Назва` may be unreadable via the API). `№` like `1.` → ID `1`; capacity `без обмежень`/blank = unlimited; non-numeric-`№` rows are skipped.
  - topic matrix, below: header row is `№ | Назва | <ISO date> | <ISO date> | …` in columns A, B, C+ (detected by A=`№` **and** B=`Назва`, which is what tells it apart from the catalog header). Each cell is that MC's topic for that day, keyed `${date}|${mcId}`; topics render as `📌 <title>: <topic>` above the buttons and inside the registration confirmation.
- **`MCResponsible`** — `MC ID | Name | Telegram ID | Added at` (bot-managed via `/addresp` or bulk-imported via `/syncresp`, which reads the catalog's `Відповідальний` column and splits multi-name cells on "і"/"й"/"та"/comma; linked by the person running `/responsible <ПІБ>`, not by typing a name at check-in). Removed via `/delresp`'s button picker, not by typed name.
- **`Videos`** — `ID | Team | File ID | Type` for per-team leader videos. `ID` is a permanent numeric key; `Team` is a display name that can be renamed. `Type` is `video_note` or `video`.
- **`Admins`** — `Telegram ID | Name` (bot-managed via `/addadmin`).
- **`Leaders`** — `Team | Name | Telegram ID | Linked at` (bot-managed via `/addleader`). The `Team` column stores the **numeric ID** matching the `Videos.ID` column.

There is no `EventRegs` or `PhishCatches` tab any more — both moved to Mongo. Old rows may still sit in the spreadsheet; nothing reads them.

### MongoDB collections (`src/mongo.ts`)

| Collection | `_id` | Contents |
|---|---|---|
| `masterclasses` | catalog `№` | Catalog copy — title, responsible text, place, capacity. Rebuilt by `/syncmc` |
| `mcSchedule` | `date\|slot` | Which MC IDs run in that slot. Rebuilt by `/syncmc` |
| `mcTopics` | `date\|mcId` | Per-day topic string. Rebuilt by `/syncmc` |
| `registrations` | ObjectId | `date, slot, mcId, telegramId, active, registeredAt, cancelledAt`. Unique partial index on `(date, slot, telegramId)` over `active: true` |
| `mcSeats` | `date\|slot\|mcId` | `taken` counter, the capacity guard. Rebuilt from active registrations by `/syncmc` |
| `visitors` | sheet `rowIndex` | Mirror of the Visitors tab + the live link state (`telegramId`, `checkedIn`, `doctorStatus`, `paymentStatus`). Refilled by `/syncvisitors` |
| `campSchedule` | `"grid"` | One doc holding the whole badge-grid slot list. Rebuilt by `/syncschedule` |
| `phishCatches` | ObjectId | `telegramId, caughtAt` — one per tap on the Telegram bait link |
| `phishScans` | ObjectId | `scannedAt` only — one per QR scan, anonymous by design |

Sync commands are admin-only and idempotent; each replaces its collection wholesale (a row deleted from the sheet disappears here too). `/syncmc` also calls `ensureIndexes()`.

### Role system

Four tiers, checked in order:

1. **Superadmin** — Telegram IDs in `ADMIN_IDS` env var. Full access.
2. **Admin** — rows in the `Admins` sheet. Manages leaders and responsible people, runs the
   four sync commands, broadcasts, reads `/stats`, corrects a wrongly-claimed check-in via
   `/fixcheckin`, and is the only role whose personal QR scan marks a medical exam
   (`?start=med_<id>`). Arg-taking commands never appear in the Telegram command menu
   (tapping a menu entry sends it with no arguments) — `/help` is where they are listed.
3. **Leader** — rows in the `Leaders` sheet. Can view their team roster (check-in status ✅/⏳ + name + age + room + special needs) and their team's masterclass registrations for today, notify team, rename team, set team video.
4. **Responsible** — rows in the `MCResponsible` sheet. Can view and message their masterclass attendees, and reveal same-day phishing-training catches via `/caught` (typed-only, no menu entry — same precedent as `/notifymc`). Independent of the leader role; a person can hold both, but each role must be claimed through its own command (`/leader`, `/responsible`) — the bot never offers them together.

### Reply keyboards

Shown automatically after check-in/link; also restored on `/start` for linked users.

| Role | Buttons |
|---|---|
| Visitor | `🎨 Майстер-класи` · `🗓 Розклад` · `📋 Мої реєстрації` |
| Leader | Visitor buttons + `👥 Моя команда` · `🎨 МК команди` · `📢 Сповістити команду` · `✏️ Перейменувати команду` |
| Responsible | Visitor buttons + `👥 Учасники МК` · `📣 Сповістити учасників МК` (stacks with leader rows) |

The default Telegram command menu (`Меню` button) is cleared for regular users — admins/superadmins keep scoped command menus.

### Check-in is a three-stage flow, not one step

Typing a name only *links* the account; the welcome, the keyboard and the team video come
at the end, after two human gates:

1. **Link** — name search → confirm button → `linkAndCheckInMongo` writes `telegramId` +
   `checkedIn` **into Mongo** (`visitors`), never into the sheet. The bot then sends the
   participant a personal QR encoding `https://t.me/<bot>?start=med_<their id>`.
2. **Doctor** — an admin scans that QR; `handleDoctorScan` stamps `doctorStatus` in Mongo and
   shows the admin the raw «Особливі потреби» cell. The participant gets «медогляд пройдено»
   plus a `🔄 Я пройшов(ла) Аню` button.
3. **Payment** — tapping that button re-checks `doctorStatus` **and** `paymentStatus`. Payment
   is never written by the bot (the financist edits the sheet by hand), so a mirrored "not
   paid" is re-read live once via `refreshPaymentStatusMongo` before the tap is refused.
   Only when both pass does `sendFinalMessage` send team/leaders/room, the role keyboard,
   the capability text, the info channel and the team video.

Every stage is re-entrant: `/start` re-sends the med QR while the exam is outstanding, a
second tap on the link button re-sends it too, and the Аня button can be pressed as often as
needed. That is deliberate — a lambda that died after the write must not cost someone their
QR, and there is no other way back into the middle of the flow.

### Key design notes

- **The sheet is no longer the check-in record** — since the 2026-08-03 incident, linking,
  check-in time, doctor status and the `/fixcheckin` release all write `visitors` in Mongo;
  `Checked in` / `Telegram ID` in the spreadsheet are frozen pre-migration values. Anything
  that needs "who is checked in" reads `getVisitorsMongo()` (`/broadcast`, `/notifyteam`,
  team roster, the reminder cron), not the tab. `findVisitorByTelegramIdMongo` keeps one
  Sheets fallback for a row the mirror doesn't have **at all**; if the mirror knows the row
  and simply doesn't point at that account, Mongo wins — otherwise a stale sheet cell would
  silently resurrect a released check-in.
- **Nothing expensive runs at module scope** — `src/bot.ts` is imported afresh on every Vercel cold start, and a check-in rush spins up many lambdas at once, so any import-time work is paid concurrently by all of them while they should be serving webhooks. Command menus used to be rebuilt there (a Sheets read plus one Telegram call per admin and leader); they are Telegram-side persistent state, already updated incrementally on every role change, and are now reconciled by hand via `/syncmenus`.
- **MongoDB is the operational store for masterclasses** (`src/mongo.ts`, `src/mc-store.ts`,
  `src/visitor-store.ts`). The catalog, schedule and topics are imported from `MCSchedule`
  by `/syncmc`; the visitors mirror from the Visitors tab by `/syncvisitors` (the full row,
  including `doctorStatus` and `paymentStatus` — both gates read Mongo, with one live Sheets
  re-read of payment when the mirror says "not paid" and nothing else would move it); the
  camp schedule from the badge grid by `/syncschedule`. Registrations live only
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
- **Masterclass list is one message per day**, not one per slot: a single `InlineKeyboard` with inert `mcnoop` header rows (`— 12:00-13:00 —`) separating each slot's masterclass buttons. The button label carries `taken/capacity` (`∞` when unlimited — a registered count is still useful there); the day's topics are `📌` lines in the message body above the keyboard, and place is shown in the registration confirmation instead. The keyboard is a point-in-time snapshot — it doesn't live-update after someone (else) registers.
- **The МК attendee list is the responsible person's working document** — `👥 Учасники МК`
  lists attendees in registration order (earliest first, so the tail is who just joined; a
  stamp-less row sorts last, not first), each line carrying age, team and the `HH:MM` of the
  registration, and each name a `tg://user?id=` link so they can be messaged directly.
  Telegram guarantees that link resolves for anyone who has contacted the bot, which every
  attendee has by virtue of registering through it; an account whose privacy settings refuse
  degrades to plain text. The list is `parse_mode: "HTML"`, so every sheet-sourced field is
  escaped on the way in, and it is sent via `replyChunked` — the markup adds ~40 characters
  per attendee and a full MC across several slots would otherwise cross the 4096-char limit
  (a 500, and a redelivered update, not a truncated message).
- **Admin delete-by-name commands prefer button pickers over typed exact names** — see `/delresp` (`src/bot.ts`): lists candidates as buttons grouped by category, with a confirm step before the actual delete. Apply the same shape if `/removeleader`/`/removeadmin` are revisited.
- **No global `bot.catch`**: an uncaught handler error becomes an HTTP 500, which Telegram retries as the same update. Handlers whose reply could exceed Telegram's ~4096-char message limit at scale (e.g. `/syncresp`'s per-name report) should chunk their output (see `replyChunked` in `src/bot.ts`) rather than risk this.
- **`/help` is the command reference, `roleCapabilitiesText()` is the one place it is composed**
  (`messages.ts`). It takes the same shape `getUserRoles()` returns plus two optional flags,
  `isAdmin`/`isSuperAdmin`, which **only `/help` passes** — the admin blocks list arg-taking
  commands (`/broadcast`, `/fixcheckin`, `/addleader`, the syncs) that can't live in the
  Telegram command menu and that admins have no buttons for. The check-in and role-link paths
  call the same function without those flags, so the post-registration message is unchanged.
  Add a new admin command → add it to `capabilitiesAdmin`, and to `commands.ts` too only if
  it takes no arguments. `/help` also prints an identity line (name, team, room, plus a tag
  per role held) so a mis-link shows up at a glance, and it lists **all** roles a person
  holds rather than picking one.
- Check-in sends the same role-capability message after the confirmation.
- **Callback data is client-supplied** — Telegram does not validate a tap against the buttons
  the message actually carries, so anyone who has ever received an inline keyboard from this
  bot can forge one with a guessed row index. Gating the *command* protects nothing: every
  admin-only callback (`delresp*`, `fixci*`) re-checks with `callbackByAdmin()` after
  `safeAnswer`. Role-link taps (`link_leader`/`link_resp`) additionally expire after 10
  minutes (`ROLE_LINK_MAX_AGE_MS`), failing closed when the message date is missing.
- **`/broadcast` runs inside a 60-second lambda** (`vercel.json` sets `maxDuration: 60` for
  `api/bot.ts`). It sends in chunks of 15 with a 1s pause, and preserves the admin's own
  formatting via `broadcastEntities()` — a bare `sendMessage(id, text)` drops all entities,
  which once turned a phishing drill's bait link into dead plain text.
- **Phishing training has two independent channels.** The Telegram one (`?start=caught`)
  knows *who* tapped and feeds `/caught` and the per-person half of `/stats`. The QR one
  (`api/phish`) is a plain https URL with no Telegram hop — harder to resist, and the only
  way to test "scanned a random QR" at all — and is anonymous: it counts scans, nothing else.
  Both writes are best-effort; the reveal must render even when Mongo is down.
- **`/stats`** (admin) reports visitors/checked-in/missing-doctor/missing-payment, MC
  registrations per date and slot, and both phishing channels. Telegram catches are deduped
  by `telegramId` (earliest tap wins, so a repeat click isn't a second victim); QR scans are
  one doc per scan and are not deduped, because there is nothing to dedupe by.
- **«Особливі потреби» has two audiences with opposite filtering rules** — the doctor's QR-scan confirmation shows the raw cell always (a missing line would be ambiguous between "nothing to report" and "the bot dropped it"), while the leader roster shows it only when `isMeaningfulNeed()` (`checkin.ts`) rejects it as filler, since a column of `⚠️ Ні` trains leaders to skip the warnings that matter. The filler list matches whole normalized values, never substrings.
- **Leader team views are read-only and button-only** — `👥 Моя команда` and `🎨 МК команди` have no slash-command equivalent and no command-menu entry, because neither takes an argument. The team↔visitor join is `Leaders.Team` against the visitor's `Номер команди` cell (trimmed, case-insensitive); the member↔registration join is the registration's `telegramId` in MongoDB, so a member with no active registration for a given slot (including one who never checked in) reads `без реєстрації`.
- **Reply keyboards are client-side and go stale on role loss** — deleting a row from `Leaders`/`MCResponsible` does not remove the buttons from that person's Telegram; the client keeps the last markup the bot sent. Every role-gated button therefore re-checks the sheet and, when the role is gone, answers via `replyRoleRevoked` (`src/bot.ts`), which attaches the caller's current keyboard (or `remove_keyboard`) so the stale buttons vanish on first press. Any new role-gated button must do the same. The reverse also holds — a role *granted* outside the `/leader`/`/responsible` link flow (typed straight into the sheet, or claimed before reply keyboards existed) sends no markup either, so `/start`, `/help` and a repeat `/leader`/`/responsible` all attach the caller's current keyboard. Telling an existing leader to press `/start` is the supported way to hand out newly added buttons; there is no proactive push.
- **A check-in link can be released, never transferred** — `/fixcheckin <ПІБ | Telegram ID>`
  (`src/bot.ts`) clears `telegramId`/`checkedIn` on one mirror row via `releaseCheckInMongo`
  (`src/visitor-store.ts`), after which both people simply check in again through the normal flow;
  there is no second check-in path to keep correct. `doctorStatus` is deliberately kept: the case
  this exists for is a *swap*, where both people really were examined. The account that claimed the
  row is identified at render time with `bot.api.getChat` — the bot has talked to every checked-in
  account by definition, so this works retroactively and stores nothing new. MC registrations are
  keyed by `telegramId` with names resolved at read time, so they follow the person and re-resolve
  once they check in correctly; nothing about them needs touching on release.
