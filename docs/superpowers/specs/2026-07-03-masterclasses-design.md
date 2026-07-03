# Masterclasses Design

**Date:** 2026-07-03
**Status:** Approved for planning

## Goal

Replace the generic Events feature with a masterclass (майстер-клас) system: a fixed
catalog of 8 masterclasses, each with a responsible person, place, and optional capacity,
running in two daily time slots (12:00–13:00 and 14:00–15:30). Visitors register for at
most one masterclass per slot. Responsible persons become a new bot role that can view
and message their attendees.

This is a **migration, not an addition**: the old Events code path and `Events` tab are
retired; the existing buttons and registration UX are repurposed.

## Sheets schema

All tabs live in the main `SHEET_ID` spreadsheet.

### `Masterclasses` (new, admin-filled catalog)

```
ID | Title            | Responsible                  | Place        | Capacity
1  | Медична допомога | Лєна Бабій і Інна Коляденко  | Ковчег       | 0
2  | Кулінарія        | Таня Кучер і Оля Даценко     | Тераса       |
...
```

- `ID` — permanent numeric key (same convention as `Videos.ID`).
- `Responsible` — display text only; actual role linking lives in `MCResponsible`.
- `Capacity` — empty or `0` = unlimited.

### `MCSchedule` (new, admin-filled availability)

One row per date+slot; lists which masterclasses run then.

```
Date       | Slot        | MC IDs
2026-07-06 | 12:00-13:00 | 1,3,5,7
2026-07-06 | 14:00-15:30 | 2,4,6,8
```

- `Date` — `YYYY-MM-DD` (matches `todayISO()`).
- `Slot` — free-form label shown to users verbatim (e.g. `12:00-13:00`); also used as
  part of the registration key, so it must be consistent within a day.
- `MC IDs` — comma-separated `Masterclasses.ID` values. IDs not found in the catalog are
  silently skipped.

### `EventRegs` (existing tab, new schema — bot-managed)

```
Date | Slot | MC ID | Telegram ID | Name | Registered at | Cancelled at
```

- Registration key = `Date + Slot + MC ID + Telegram ID`.
- Cancellation is a soft delete: timestamp in `Cancelled at` (same pattern as before).
- Old event-registration rows must be cleared manually when the header is updated
  (one-time sheet migration by the admin).

### `MCResponsible` (new, bot-managed via admin commands)

```
MC ID | Name | Telegram ID | Added at
```

- Mirrors the `Leaders` tab pattern: admin adds an unlinked row (`Telegram ID` empty);
  the person is linked automatically when they check in by matching name.
- One person may have several rows (e.g. Лєна Кротик → MC 6 and MC 8).
- One MC may have several people (e.g. MC 1 → Лєна Бабій and Інна Коляденко as separate
  rows).

### Retired

- `Events` tab — no longer read by the bot. Can be deleted from the sheet.

## Code changes

### `src/masterclasses.ts` (new module, replaces `src/events.ts`)

- `Masterclass` interface: `id`, `title`, `responsible`, `place`, `capacity`.
- `SlotSchedule` interface: `date`, `slot`, `mcIds: string[]`.
- `MCRegistration` interface: `rowIndex`, `date`, `slot`, `mcId`, `telegramId`, `name`,
  `cancelled`.
- `loadMasterclasses()`, `loadMCSchedule()`, `loadMCRegistrations()` — sheet readers
  following the `headerIndex` pattern.
- `todaySlots(schedule)` — `MCSchedule` rows for `todayISO()`.
- `activeRegs(regs, date, slot, mcId)` — non-cancelled registrations for one occurrence.
- `register(date, slot, mcId, capacity, telegramId, name)` →
  `"ok" | "full" | "already" | "slot_taken"`:
  - `"already"` — user already registered for this exact masterclass in this slot;
  - `"slot_taken"` — user holds an active registration for a *different* masterclass in
    the same date+slot (must cancel it first — no auto-switch);
  - `"full"` — capacity > 0 and reached.
- `unregister(date, slot, mcId, telegramId)` — soft-cancel, returns boolean.
- Same accepted race window on capacity as the old events code (no transactions; camp
  scale).

### `src/responsible.ts` (new module, mirrors `src/leaders.ts`)

- `loadResponsible()`, `findResponsibleByTelegramId()`, `searchResponsibleByName()`
  (unlinked rows, same prefix-match normalization), `setResponsibleTelegramId()`,
  `addResponsible(mcId, name)`, `removeResponsible(mcId, name)`.

### `src/events.ts` — deleted.

### `src/config.ts`

- New tab-name config entries: `masterclassesTab` (`Masterclasses`), `mcScheduleTab`
  (`MCSchedule`), `responsibleTab` (`MCResponsible`). `registrationsTab` keeps pointing
  at `EventRegs`. `eventsTab` is removed.

### `src/keyboards.ts`

- `BTN.events` text: «📅 Події сьогодні» → «🎨 Майстер-класи».
- `BTN.myEvents` («📋 Мої реєстрації») unchanged.
- New `BTN.mcAttendees` «👥 Учасники МК» and `BTN.mcNotify` «📣 Сповістити учасників МК».
- Keyboard is composed from roles: base visitor rows; + leader rows if leader;
  + responsible rows if responsible. A person can be both leader and responsible.

### `src/bot.ts`

**Visitor flow** («🎨 Майстер-класи» button and `/mc` command):

1. Read `MCSchedule` for today. No rows → «Сьогодні майстер-класів немає.»
2. For each slot (in sheet order), send **one message per slot** listing that slot's
   masterclasses, with an inline keyboard: one button per masterclass —
   `Назва (Місце) — N/Cap` (or `N` when unlimited), prefixed `✅` for the one the user
   is registered in.
3. Callback data: `mcreg:<date>:<slot>:<mcId>` and `mcunreg:<date>:<slot>:<mcId>`.
   Tapping a ✅ masterclass cancels; tapping another while holding one in that slot
   answers with a "cancel yours first" message (`slot_taken`); tapping a full one
   answers «місць немає».

**My registrations** («📋 Мої реєстрації» button and `/myevents` command): lists the
user's active masterclass registrations for today and future dates as
`дата, слот — Назва (Місце)`.

**Responsible flow:**

- «👥 Учасники МК» — for each of the user's masterclasses running today (from
  `MCSchedule`), per slot: title, slot, place, attendee names, count vs capacity.
  If none of their MCs run today: «Сьогодні ваших майстер-класів немає.»
- «📣 Сповістити учасників МК» — if the user's MCs occupy more than one occurrence
  today (several MCs or both slots), show an inline picker of occurrences first;
  then prompt for message text (same in-memory pending-text pattern as the leader
  notify flow); send to every active registrant's Telegram ID; report delivered/failed
  counts.

**Admin commands:**

- `/addresp <mcId> <Ім'я Прізвище>` — add unlinked responsible row (validates the MC ID
  exists in the catalog).
- `/delresp <mcId> <Ім'я Прізвище>` — clear the row.
- Both admin- and superadmin-accessible, listed in the scoped command menus
  (`src/commands.ts`).

**Check-in linking:** the existing check-in name-match flow additionally searches
unlinked `MCResponsible` rows (like it does for leaders) and links all matching rows to
the user's Telegram ID, then shows the combined keyboard.

**Removed:** `/events` command, old `handleEvents`/`handleMyEvents` event rendering,
`reg:`/`unreg:` callbacks (replaced by `mcreg:`/`mcunreg:`), events fallback inside
`handleSchedule` — when the grid is unavailable the «Розклад» handler now replies with a
new `M.scheduleUnavailable` string («Розклад тимчасово недоступний.») instead of listing
events.

### `src/messages.ts`

All new user-facing strings in Ukrainian added to `M`: masterclass list headers, slot
headers, registration confirmations (`"ok"`, `"full"`, `"already"`, `"slot_taken"`),
my-registrations lines, responsible attendee-list and notify strings, admin command
usage/feedback for `/addresp`/`/delresp`.

### `src/commands.ts`

Scoped menus updated: `/mc` replaces `/events` where present; `/addresp`, `/delresp`
added to admin and superadmin menus.

## Registration rules (summary)

- At most one active masterclass registration per user per date+slot; switching requires
  cancelling first (no auto-switch).
- Both slots on the same day allowed; the same masterclass on different days allowed.
- Capacity enforced at registration time; blank/`0` = unlimited.
- Registration is for **today only** (the UI never shows future days).

## Edge cases

- `MCSchedule` references an unknown MC ID → skipped silently.
- Masterclass in catalog but never scheduled → simply never shown.
- Responsible person whose MC doesn't run today → attendee/notify buttons reply with an
  "nothing today" message.
- Blocked bot / failed sends during notify → counted and reported, not fatal
  (same as team notify).
- Keyboard churn from the renamed button: Telegram replaces the reply keyboard on the
  next `/start` or check-in; stale «📅 Події сьогодні» taps fall through to name search
  and return no results — acceptable, users at camp re-open `/start` routinely.

## Verification

`npm run typecheck` must pass; behavior confirmed after `npx vercel --prod` +
`npm run set-webhook` (no tests, no local dev server in this repo).

## One-time sheet migration (manual, by admin)

1. Create `Masterclasses` tab and fill the 8-row catalog.
2. Create `MCSchedule` tab and fill dates/slots.
3. Replace the `EventRegs` header row with the new columns; delete old data rows.
4. Create `MCResponsible` tab with the header row.
5. (Optional) delete the `Events` tab.
