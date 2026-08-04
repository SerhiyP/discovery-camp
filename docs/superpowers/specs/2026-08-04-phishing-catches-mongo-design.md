# Phishing catches: move to Mongo

## Context

`src/phishing.ts` still reads/writes the `PhishCatches` sheet tab (`logCatch`/`loadCatches`),
while its two call sites in `src/bot.ts` already deal exclusively in Mongo-backed data:

- `/start caught` (deep link from the phishing-awareness exercise) → `logCatch`
- `/caught` (`renderCaught`) → `loadCatches`, alongside `getRegistrations()` and
  `getVisitorsMongo()`, both already Mongo.

This is the last Sheets read/write left in that flow. Following the precedent set by the
MC/registrations cutover (see `2026-08-03-mongo-operational-store-design.md`), move it to
Mongo too: Mongo-only, no sheet fallback, no backfill of historical rows.

## Design

- **`src/mongo.ts`**: add `phishCatches: "phishCatches"` to `COLLECTIONS`.
- **`src/phishing.ts`**: keep the same module boundary (`logCatch`, `loadCatches`,
  `PhishCatch`) but swap the implementation from `sheets.ts` to `mongo.ts`:
  - `logCatch(telegramId)` → `insertOne({ telegramId, caughtAt: nowStamp() })` into
    `phishCatches`. No dedup — the existing consumer (`renderCaught`) already reduces to
    the earliest catch per `telegramId`.
  - `loadCatches()` → `find({}).toArray()`, mapped to `PhishCatch[]`. No sort needed for
    the same reason.
- Drop `appendRow`/`getRows`/`headerIndex` imports and the `config.phishCatchesTab`
  reference from `phishing.ts`.
- `config.phishCatchesTab` and the `PhishCatches` sheet tab are left untouched — same
  treatment as the retired `EventRegs` tab: historical rows stay readable there, but
  nothing reads or writes it going forward.
- No new call sites, no signature changes. Both call sites (`bot.ts:144`, `bot.ts:1286`)
  are already wrapped in `mongoGuarded`, so no new error handling is needed — a Mongo
  outage on `/start caught` already degrades to the existing best-effort
  try/catch around `logCatch`, and `/caught` already replies with the standard
  «Тимчасова помилка» via `mongoGuarded`.
- Mongo starts empty for this collection; no backfill script for historical sheet rows.

## Out of scope

- Backfilling existing `PhishCatches` sheet rows into Mongo.
- Any change to how `/start caught` or `/caught` are triggered or rendered.
