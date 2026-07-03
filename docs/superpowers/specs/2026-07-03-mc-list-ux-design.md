# Masterclass List UX Design

**Date:** 2026-07-03
**Status:** Approved for planning

## Goal

The «🎨 Майстер-класи» button currently sends **one message per time slot** (today:
12:00-13:00 and 14:00-15:30), each with a bullet-list of all 8 masterclasses plus an
inline keyboard repeating the same titles as buttons. For a 2-slot day that's 2 messages,
16 buttons, and every masterclass named twice (once in text, once on a button) — too much
to scan at once.

Replace it with **one message for the whole day**: a single inline keyboard grouped by
slot, with all decision-relevant info (title, spots left) on the button itself. No
separate bullet list.

## Current behavior (for reference)

`handleMasterclasses` (`src/bot.ts:178-207`) already loads the catalog, schedule, and
registrations once via `Promise.all` and loops over slots in memory — this change only
affects how that data is rendered, not how it's fetched.

## Design

### Message

One `ctx.reply` per day instead of one per slot:

- Text: a short header, `M.mcDayTitle` → `"🎨 Майстер-класи сьогодні:"`. No per-item
  bullet list.
- Keyboard: a single `InlineKeyboard` covering every slot for the day, in schedule order:
  - An inert header row per slot: `— 12:00-13:00 —` (see "Header rows" below).
  - One button per masterclass in that slot, in the order listed in that slot's
    `MC IDs` column (same order used today):
    `${mine ? "❌" : "📝"} ${mc.title}${mc.capacity > 0 ? \` — ${taken}/${mc.capacity}\` : ""}`
    — same mine/capacity logic as today, **minus** the place, which is dropped from the
    button (see "Place" below).
  - Masterclasses with an unknown ID or oversized callback data are still skipped
    silently (existing 64-byte guard), same as today.
  - A slot that ends up with zero valid buttons contributes **no header row** either —
    don't show a heading with nothing under it.
- If the whole day has zero valid buttons across all slots, skip the keyboard entirely
  and reply with the existing `M.noMasterclassesToday`.

This keeps working unchanged if a day ever has more or fewer than 2 slots — it's not
hardcoded to 2.

### Header rows

Slot header buttons (`— 12:00-13:00 —`) are real inline buttons (Telegram has no
non-button "label" row) with callback data `mcnoop`. A new handler:

```ts
bot.callbackQuery("mcnoop", (ctx) => ctx.answerCallbackQuery());
```

acks the tap with no other effect — no reply, no state change, no spinner hang.

### Place

Place (`Місце проведення`) is dropped from the list/button entirely. It reappears in the
registration confirmation instead, so visitors still see it right after signing up (and
any time via «Мої реєстрації», which already shows place per line):

- `M.mcRegistered` gains a third parameter:
  `mcRegistered: (title: string, slot: string, place: string) =>
  \`Ви зареєстровані на «${title}» (${slot}, ${place}) ✅\``
- Both call sites in the `mcreg:` callback handler (`src/bot.ts:254`, `:263` — the
  `answerCallbackQuery` alert text and the follow-up `ctx.reply`) pass `mc.place`.
- `M.mcUnregistered` is unchanged (place isn't relevant when cancelling).

### Removed

- `M.mcSlotTitle` and `M.mcLine` (`src/messages.ts:16-24`) — no longer referenced once
  the per-slot text list is gone.

### Unaffected

- `register`/`unregister` logic, capacity/slot-taken rules, `EventRegs` schema.
- `mcreg:`/`mcunreg:` callback data format and the stale-date (`date !== todayISO()`)
  guard.
- `handleMyRegs` («Мої реєстрації») — already shows place per line, no change needed.
- Data-fetching: still exactly the 3 `Promise.all`-batched Sheets reads per invocation
  that exist today; this is a rendering change only.

## Edge cases

- Zero masterclasses scheduled today → `M.noMasterclassesToday`, no keyboard (unchanged
  from today's behavior, just now evaluated across the whole day instead of per slot).
- A slot with all-unknown or all-oversized-callback-data masterclasses → slot silently
  contributes nothing (no header, no buttons), same skip-on-empty rule as full-day.
- Button/message limits: a 2-slot day with 8 masterclasses each is 2 header rows + up to
  16 masterclass buttons = 18 rows, well under Telegram's inline keyboard limits. Message
  text is a one-line header, well under the 4096-char limit. No limit concerns even if a
  day grows to 3+ slots.
- Tapping a header row (`mcnoop`) does nothing observable — acceptable, it's not meant to
  be tappable, just a visual separator.

## Verification

`npm run typecheck` must pass; behavior confirmed after `npx vercel --prod` (no tests, no
local dev server in this repo, per existing convention). `npm run set-webhook` is not
needed — the webhook already points at the stable production domain
(`discovery-camp.vercel.app`), which doesn't change between deploys.
