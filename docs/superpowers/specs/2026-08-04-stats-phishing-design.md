# /stats: show phishing-catch info — Design

**Date:** 2026-08-04
**Status:** Approved for planning

## Goal

`/stats` (admin-only, `src/bot.ts`) currently reports visitor counts, check-in/doctor/payment
status, and MC registrations. Add a phishing-awareness section so admins can see camp-wide
how the training is landing, without having to ask each responsible person to run `/caught`.

## Behavior

`bot.command("stats", ...)` fetches `loadCatches()` (`src/phishing.ts`) alongside the existing
`getVisitorsMongo()`/`getRegistrations()` calls, in the same `Promise.all`.

A new section is appended to `formatStats`'s output, after the MC-registrations block:

- **Unique caught**: dedup `PhishCatch[]` by `telegramId`, keeping the earliest `caughtAt` per
  person (same dedup as `renderCaught`, `src/bot.ts:1287`) → count of distinct people ever
  caught, camp-wide.
- **Total catch events**: raw `catches.length` — repeat clicks by the same person count each
  time, consistent with `PhishCatches` being an undeduped append-only log by design (see
  `docs/superpowers/specs/2026-07-27-phishing-catch-design.md`, "Out of scope").
- **Per-day breakdown**: group the *deduped* people by the `YYYY-MM-DD` date of their earliest
  catch (`caughtAt.slice(0, 10)`), one line per day, sorted ascending.
- Zero catches: a single "nobody caught yet" line, no breakdown.

Example:
```
🎣 Фішинг:
Спіймано: 12 осіб (15 спрацювань)

За днями:
  2026-08-03: 5
  2026-08-04: 7
```

## Data model

No changes — reuses `loadCatches()` from `src/phishing.ts` as-is.

## `src/messages.ts`

New keys alongside the existing `stats*` block:

```ts
statsPhishTitle: "🎣 Фішинг:",
statsPhishCaught: (unique: number, events: number) =>
  `Спіймано: ${unique} осіб (${events} спрацювань)`,
statsPhishNoCatches: "Ще ніхто не попався.",
statsPhishDayLine: (date: string, count: number) => `  ${date}: ${count}`,
```

## `src/bot.ts`

- `formatStats(visitors, regs, catches)` gains a third parameter.
- New local helper (e.g. `formatPhishStats(catches): string[]`) does the dedup/group/format
  and is called from `formatStats`; keeps `formatStats` from growing an unrelated block of
  logic inline, matching the existing per-section shape of the function.
- `/stats` handler passes `catches` from the expanded `Promise.all`.

## Out of scope

- Per-MC or per-occurrence breakdown in `/stats` — that's what `/caught` is for. This is a
  camp-wide total only.
- Any change to `logCatch`/`loadCatches` or the `PhishCatches` collection.

## Edge cases

- A person caught on two different days: attributed to the day of their *earliest* catch only
  (matches "unique caught" using earliest-per-person), so day counts sum to the unique total.
- Empty `PhishCatches` collection: `statsPhishNoCatches`, no day breakdown, no crash.

## Verification

`npm run typecheck` must pass. Manual check: run `/stats` as an admin before and after seeding
a few `PhishCatches` rows (or after real `/start caught` clicks) and confirm the counts and
day breakdown match.
