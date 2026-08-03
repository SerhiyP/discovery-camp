# Check-in linking moves to Mongo (row-shift incident)

Date: 2026-08-03

## Incident

A row inserted into the source spreadsheet shifted every row below it. `Checked in`,
`Telegram ID` and `Лікар` are plain typed values in fixed physical rows — not part of the
`IMPORTRANGE`'d block that moves with the source edit — so they desynced from the names
now sitting at those rows. Recovery: clear `Checked in`/`Telegram ID` in the sheet and have
every visitor re-check-in, rather than a surgical per-row repair.

## Shipped today

- `linkAndCheckInMongo` (`visitor-store.ts`): check-in linking now reads/writes the Mongo
  visitors mirror instead of the sheet. Sheets writes (`updateCell`) have no batching or
  retry, unlike reads — a mass re-check-in would have hit the write quota.
- `loadRoleContext` resolves the visitor via `findVisitorByTelegramIdMongo`, not the sheet.
- `doctorStatus`/`paymentStatus` synced into Mongo by `/syncvisitors`. A visitor already
  fully processed pre-incident (both true) skips straight to the final message; otherwise
  the normal flow (med QR → `checkanya`) applies unchanged.
- `handleDoctorScan` writes `doctorStatus` to Mongo only now — sheet no longer touched.
- `refreshPaymentStatusMongo`: one-off live Sheets read when Mongo shows "not paid",
  since nothing writes `paymentStatus` live (financist edits the sheet directly). Mirrors
  the existing telegramId miss-then-backfill pattern.
- All Mongo-dependent handlers wrapped in `mongoGuarded`.

**Accepted risk:** `doctorStatus` was historically written via a Telegram-ID sheet lookup —
the same mechanism the row shift corrupted — so pre-incident values carry residual risk for
whatever range was actually affected. Trusted anyway today for speed.

## Deferred to tomorrow: move name search to Mongo too

Name search (`bot.on("message:text")`) still reads `sheet.visitors` live from Sheets. Left
alone today deliberately — reads are batched + retried, they weren't the risk that caused
this incident, and moving them needs a miss-then-backfill path to avoid hiding a same-day
roster edit (like today's).

This is step 3 of `2026-08-03-mongo-operational-store-design.md`'s rollout ("switch
check-in name search to Mongo with the Sheets fallback"), previously deferred to
"post-camp" — worth pulling forward now since the visitor mirror and role context are
already migrated as a side effect of today's fix.

Plan:
- Search `getVisitorsMongo()` instead of `sheet.visitors`. `searchByName` is already a pure
  function over `Visitor[]`, so this should be close to a drop-in swap.
- On zero matches, fall back to one live Sheets search, same shape as
  `findVisitorByTelegramIdMongo`'s miss/backfill, so a same-day roster edit is still
  findable without waiting on `/syncvisitors`.
- `/syncvisitors` stays the explicit sync command — no automatic polling.
