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
- The common path — `/start`, `/help`, any typed message, check-in name search — costs
  **zero** Sheets read requests.
- Admins can re-sync from Sheets on demand when they edit a tab.

Reaching zero on the common path requires moving `Leaders`, `MCResponsible`, `Admins` and
`Videos` as well, not just `Visitors`. `loadRoleContext` batches all three role tabs into
one request; since quota counts requests rather than ranges, leaving any of them in Sheets
means the request still happens and moving the others saves nothing.

## Non-goals

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
| Leaders, MCResponsible, Admins | Sheets | cache; refreshed by `/syncroles` and written through on every bot write |
| **Videos** | **Mongo, only copy** | leaders write it by sending a video; the tab is imported once and then unused |
| Badge-grid schedule | Sheets (`gridSheetId`) | cache; refreshed by `/syncschedule` |

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
leaders         { _id: rowIndex, team, name, telegramId }
responsible     { _id: rowIndex, mcId, name, telegramId }
admins          { _id: rowIndex, telegramId, name }
videos          { _id: videoId, fileId, type }
teams           { _id: teamId, name }
campSchedule    { _id: "grid", slots: [{ time, activity }] }
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
- `leaders`, `responsible`, `admins`: `telegramId`.

The role collections mirror their tabs and are keyed by row index for the same reason as
`visitors` — the existing `updateCell` write paths address rows by index. They follow the
same replace-not-upsert rule on sync.

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

### Role lookup

`loadRoleContext` — which backs `/start`, `/help`, every typed message and the check-in
flow — reads `visitors`, `leaders` and `responsible` from Mongo. Zero Sheets reads.

Sheets stays the source of truth for these tabs: admins edit them by hand, and the bot's
own writes (`/addleader`, `/addadmin`, `/addresp`, `/delresp`, role linking) continue to
write to Sheets and **write through** to Mongo in the same operation, so a role granted
via the bot takes effect immediately.

The gap is a role typed directly into a sheet, bypassing the bot. Today that takes effect
as soon as the person presses `/start`; with this change it takes effect after an admin
runs `/syncroles`. CLAUDE.md currently documents "tell the leader to press `/start`" as the
supported way to hand out newly added buttons, and needs updating to say `/syncroles`
first.

### Team videos

`videos` is Mongo-owned, not a cache. A `file_id` is an opaque Telegram string with no
value to anyone reading a spreadsheet, so the tab has no human reader.

Leaders set their own team's video by sending one to the bot, exactly as today. There is
no admin command and no pasting a `file_id` into a sheet — that route is removed. A team
whose leader never sends one falls back to `DEFAULT_VIDEO_FILE_ID`, so no team ends up
with nothing.

The `Videos` tab is imported into Mongo by `/syncvideo`, which is run once during rollout;
the tab is not read or written afterwards.

`/syncvideo` **only inserts team IDs missing from Mongo** and leaves existing documents
untouched, reporting both counts. It is not a replace. Mongo owns this collection, so a
replacing sync would discard every video a leader had sent since the import — and a
one-time command is exactly the kind that gets re-run months later by someone who does not
remember that. Making it safe to re-run is cheaper than relying on nobody re-running it.

### Renaming a team

Renaming currently costs one Sheets write **per team member** (`checkin.ts:232` loops
`updateCell` over every visitor on the team), against the 60-writes-per-minute quota.

The rename now writes **Mongo only**. The Visitors tab is not touched.

That cannot work while the team display name is duplicated across every visitor document,
because `/syncvisitors` replaces that collection from Sheets and would silently revert the
rename. So the name moves out of the visitor documents entirely:

```
teams   { _id: teamId, name }
```

Visitor documents keep the raw team cell from the sheet as the join key; the display name
is looked up from `teams`. Renaming becomes a single-document update — one write, atomic,
nothing to loop over and nothing for a sync to clobber.

This also removes the reason the old code was slow: it looped a write per member precisely
because the name was copied into every member's row. With that gone, no `batchUpdateCells`
helper is needed — the rename loop was its only caller worth fixing.

Consequence, accepted deliberately: the Visitors tab keeps showing the pre-rename value.
Staff reading that tab see the original name; the bot shows the new one everywhere.

`linkResponsibleRows` has the same per-row write loop, but touches one to three rows for a
single person on a command run a handful of times per camp. Left alone.

### Camp schedule

`🗓 Розклад` reads a second spreadsheet (`config.gridSheetId`, tab
`3.Розклад табору 2026`). It is human-maintained, read-only, unchanged for the whole camp,
and pressed many times a day — the strongest cache candidate in the system.

`schedule.ts` applies no per-date filtering: it reads columns 8 and 9 of every row, so the
slot list is identical on every camp day. Only `dayLabel`, `isToday` and `isCurrent` are
derived from the clock. The cache is therefore a single document holding the slot list,
with all date and time logic staying in `schedule.ts` and running per request.

`loadTodaySchedule()` keeps its exact signature and `ScheduleResult` shape; only the row
fetch is swapped. An empty collection returns `{ status: "unavailable" }`, matching the
current behaviour when the grid is unreadable.

### Admin commands

- `/syncmc` — re-read `MCSchedule`, replace catalog, schedule and topics. Reports counts.
- `/syncvisitors` — refresh the visitor cache from the Visitors tab.
- `/syncroles` — refresh `leaders`, `responsible` and `admins` from their tabs. Needed
  after editing a role tab by hand. **Deliberately excludes `videos` and `teams`**: Mongo
  owns both, so replacing them from Sheets would discard videos leaders have set and
  revert team renames.
- `/syncvideo` — import the `Videos` tab into Mongo. Run once at rollout; safe to re-run.
- `/syncschedule` — refresh the camp schedule from the badge-grid spreadsheet.
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

**Decision 2026-08-03: no automated tests for the in-camp rollout (steps 1–2 + schedule).**
Verification is `npm run typecheck` plus the manual production checklist in the plan's
final task, run before the 13:00 Kyiv cron. The list below stands as the behaviour
contract and as the test plan if suites are written in the post-camp phase:

- Concurrent registrations for the last seat: exactly one succeeds.
- Duplicate registration for the same slot is rejected by the index, not by a read.
- Name-search miss falls back to Sheets and populates the cache.
- The payment gate reads Sheets even when the visitor is cached.
- Cancelling frees the slot: re-registering for the same slot after a cancel succeeds.
- A role granted through the bot is effective immediately (write-through), without a sync.
- `/syncroles` leaves `videos` untouched: a video set by a leader survives a re-sync.
- A team with no video falls back to `DEFAULT_VIDEO_FILE_ID`.
- Renaming a team issues no Sheets write at all, and survives a `/syncvisitors` run.
- `/syncvideo` is safe to re-run: a video a leader set after the import is not overwritten.
- `🗓 Розклад` issues no Sheets request, still highlights the current activity from the
  clock, and reports "unavailable" when the schedule collection is empty.
- `/start` for a checked-in visitor issues no Sheets request at all — the measurable
  restatement of the "zero on the common path" goal, in the style of the existing
  `checkin-reads` suite.
- The three existing suites (`batch`, `checkin-reads`, `qr-recovery`) stay green.

## Rollout

The camp is live, so ordering matters:

1. Ship sync + `/syncmc` + `/syncvisitors` + `/syncroles` first, reading from Mongo nowhere
   yet. Verifies the connection and the data shape with zero behaviour change.
2. Switch masterclass registration to Mongo. There are no existing registrations, so there
   is nothing to migrate and no dual-read period.
3. Switch check-in name search to Mongo with the Sheets fallback.
4. Switch `loadRoleContext` to Mongo and add write-through on the role write paths. Last
   because it is the change that touches every command, and because until it lands the
   earlier steps have not yet reduced `/start` to zero.
5. `/syncvideo` to import the `Videos` tab, then switch video lookup and leader video
   updates to Mongo. Populate `teams` and switch rename to Mongo in the same step.

### Priority

All quota fixes to date are deployed and production is current. Check-in is essentially
complete for this camp — almost everyone is registered — so steps 3, 4 and 5 serve a path
that is already behind us. They are robustness work for next year.

**Steps 1 and 2 are time-boxed.** The `mc-reminder` cron fires daily at 13:00 Kyiv
(`0 10 * * *` UTC) and pushes 60–100 people into `mcreg` at once, at three reads per tap.
That is the next and last high-pressure moment of this camp, and it repeats every day
until 2026-08-07.

Steps 1–2 need one slice of step 3 pulled forward: a **visitors mirror used only for
`telegramId` lookups**. Registrations store `telegramId`, so the attendee views
(`👥 Учасники МК`, `/caught`) need somewhere to resolve names once `EventRegs` stops
storing them, and the `mcreg` check-in gate needs a zero-read lookup. The mirror is
synced by `/syncvisitors`, write-through on check-in, Sheets fallback on a miss; payment
and doctor status are never mirrored. Check-in name search stays on Sheets until the
post-camp phase. With that in place, the whole masterclass path — listing, registering,
cancelling, `📋 Мої реєстрації`, attendee lists, team MC view, `/notifymc`, the reminder
cron — costs zero Sheets reads without the rest of steps 3–5.

The camp schedule ships alongside them. It is read-only, static for the whole camp, and
pressed many times a day, so it is the cheapest remaining read to eliminate and carries
almost no risk: no writes, no staleness beyond an admin editing the grid, and a single
document.

Ship 1–2 plus the schedule before the next reminder. Treat 3–5 as post-camp.

Each step is independently revertible.

## Retiring EventRegs

The `EventRegs` tab stops being written and stops being read. Every view humans need is
already in the bot — `📋 Мої реєстрації`, `👥 Учасники МК`, `🎨 МК команди` — so nothing
depends on the tab during camp.

Mongo therefore becomes the only copy of registration data. That is a deliberate choice.
The tab itself is left in place rather than deleted, so any pre-Mongo rows stay readable.

CLAUDE.md documents `EventRegs` as a bot-managed tab and records the registration race
window as accepted; both need updating as part of this work.
