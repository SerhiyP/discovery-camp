# MongoDB as the operational store

Date: 2026-08-03

## Problem

Google allows 60 Sheets read requests per minute per user, and the service account is a
single "user" shared by the whole camp. Batching (`sheets.ts`) brought check-in down from
16 requests per participant to 6 and masterclass registration to 3, but the ceiling itself
cannot be raised by code. With 60–100 participants reminded about a masterclass slot at
once, registration taps land in the same minute or two and saturate the quota again.

A second, independent problem: `EventRegs` capacity is enforced by reading the tab,
counting, and appending. There is no atomicity, so two people can take the last seat.
CLAUDE.md currently documents this as accepted.

## Goals

- Masterclass registration costs **zero** Sheets read requests.
- Capacity and one-registration-per-slot become database guarantees, not races.
- Check-in finds participants without reading Sheets on the common path.
- Admins can re-sync from Sheets on demand when they edit a tab.

## Non-goals

- Moving `Leaders`, `Admins`, `MCResponsible` or `Videos`. They are small, bot-managed,
  and already cost one batched request. Moving them buys nothing.
- Removing Sheets. It stays the human-facing surface and the source of truth for
  everything humans and Google Forms write.
- A Sheets fallback path for registration when Mongo is unavailable. See
  "Failure behaviour".

## Data ownership

| Data | Source of truth | Mongo's role |
|---|---|---|
| MC catalog, schedule, topics | Sheets `MCSchedule` | synced copy, refreshed by `/syncmc` |
| **Registrations** | **Mongo, only copy** | `EventRegs` is retired; nothing writes it |
| Visitors | Sheets (Forms + Аня + staff) | cache; a miss falls back to a Sheets read |
| Payment + doctor gate | Sheets | **never cached** — read live |
| Leaders, Admins, MCResponsible, Videos | Sheets | unchanged |

The Visitors row is the important one. The bot never writes `Статус оплати`; Аня marks it
by hand, and new participants arrive from a Google Form. Mongo therefore cannot own that
tab — it can only mirror it.

## Collections

```
masterclasses   { _id: mcId, title, responsible, place, gifts, capacity }
mcSchedule      { _id: "<date>|<slot>", date, slot, mcIds: [] }
mcTopics        { _id: "<date>|<mcId>", date, mcId, topic }
visitors        { _id: rowIndex, name, nameNorm: [], age, room, team,
                  specialNeeds, telegramId, checkedIn }
registrations   { date, slot, mcId, telegramId, registeredAt,
                  active: true, cancelledAt }
```

Indexes:

- `registrations`: **unique** on `(date, slot, telegramId)` as a partial index over
  `{ active: true }` — makes "one active registration per slot" a database guarantee.
  The explicit `active` boolean exists so the partial filter is a plain equality; a
  predicate on `cancelledAt: null` would also match documents where the field is absent
  and is easy to get subtly wrong. Cancelling sets `active: false`, which frees the slot
  for re-registration while keeping `cancelledAt` for the record.
- `registrations`: `(date, slot, mcId)` for capacity counts.
- `visitors`: `telegramId`, and `nameNorm` for prefix search.

`visitors._id` is the sheet row index, which is what the existing `updateCell` write path
needs. Row indices are stable while Google Forms appends at the bottom, but a staff
deletion shifts every row below it. `/syncvisitors` therefore **replaces** the collection
rather than upserting into it, so deletions and shifts self-correct on the next sync; the
fallback-on-miss covers the window in between.

## Flows

### Check-in

1. Participant sends their name. Search `visitors.nameNorm` in Mongo — **0 Sheets reads**.
2. On a miss, fall back to a Sheets read and refresh the cache. This is what makes an
   on-site form registration work without waiting for an admin to re-sync.
3. Taking their name writes `Telegram ID` and `Checked in` to Sheets as today, and
   write-through to the Mongo visitor doc so the next interaction sees the link.
4. Send the doctor QR.
5. «Я пройшов(ла) Аню» reads the visitor row **live from Sheets** — once per participant,
   spread across check-in, and never stale. Аня's workflow does not change.

### Masterclass registration

Zero Sheets reads:

1. Catalog, schedule and capacity come from Mongo.
2. Insert into `registrations`. The unique index rejects a duplicate; a conditional insert
   guarded by a capacity count rejects an overfull slot. Two people cannot take the last
   seat.
3. Reply. There is no Sheets write at all — registration touches neither the read nor the
   write quota.

The participant's name is not needed here. `registrations` stores `telegramId`; names are
resolved from the visitor cache when rendering attendee lists.

### Admin commands

- `/syncmc` — re-read `MCSchedule`, replace catalog, schedule and topics. Reports counts.
- `/syncvisitors` — refresh the visitor cache from the Visitors tab.
There is no registration export. Registrations live in Mongo and stay there.

All three are admin-gated and typed-only, following the `/syncresp` precedent.

## Failure behaviour

If Mongo is unavailable, registration replies "спробуйте за хвилину" rather than throwing.
An uncaught error becomes HTTP 500, which Telegram retries as the same update — the
amplification loop that turned the quota problem into an outage.

There is deliberately **no Sheets fallback for registration writes**. Two live write paths
to the same data is how split-brain happens, and it doubles the surface at exactly the
moment things are already going wrong.

## Serverless connection handling

`api/bot.ts` has `maxDuration: 10`, and Vercel spawns many concurrent lambdas under a
check-in rush. The client must be created once at module scope and reused across
invocations, with a small `maxPoolSize` (~5) so instances do not exhaust the Atlas
connection limit, and connect timeouts well inside the 10s budget. The
`mongodb-connection` skill covers the specifics and should be consulted during
implementation.

## Testing

Following the pattern established by the quota work — stubbed drivers, no live services:

- Concurrent registrations for the last seat: exactly one succeeds.
- Duplicate registration for the same slot is rejected by the index, not by a read.
- Name-search miss falls back to Sheets and populates the cache.
- The payment gate reads Sheets even when the visitor is cached.
- Cancelling frees the slot: re-registering for the same slot after a cancel succeeds.
- The three existing suites (`batch`, `checkin-reads`, `qr-recovery`) stay green.

## Rollout

The camp is live, so ordering matters:

1. Ship sync + `/syncmc` + `/syncvisitors` first, reading from Mongo nowhere yet. Verifies
   the connection and the data shape with zero behaviour change.
2. Switch masterclass registration to Mongo. There are no existing registrations, so there
   is nothing to migrate and no dual-read period.
3. Switch check-in name search to Mongo with the Sheets fallback.

Each step is independently revertible.

## Retiring EventRegs

The `EventRegs` tab stops being written and stops being read. Every view humans need is
already in the bot — `📋 Мої реєстрації`, `👥 Учасники МК`, `🎨 МК команди` — so nothing
depends on the tab during camp.

Mongo therefore becomes the only copy of registration data. That is a deliberate choice.
The tab itself is left in place rather than deleted, so any pre-Mongo rows stay readable.

CLAUDE.md documents `EventRegs` as a bot-managed tab and records the registration race
window as accepted; both need updating as part of this work.
