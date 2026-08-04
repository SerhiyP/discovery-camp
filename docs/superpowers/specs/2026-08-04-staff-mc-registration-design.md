# Staff masterclass registration — design (parked)

**Status: parked 2026-08-04. Not implemented.** Judged too complex for the value at the
time it was designed. Kept because the decisions in it were made deliberately and the
cheap subset (part A) is worth picking up on its own.

## Problem

`mcreg` (`src/bot.ts`) requires a checked-in visitor row (`findVisitorByTelegramIdMongo`)
before it will register anyone. Two groups fall outside that:

1. **Leaders and admins** who are not in the Form Responses sheet. They have no visitor row
   and can never get one, so tapping any masterclass button answers «Спершу відмітьтесь».
2. **Participants without a phone.** Check-in is self-service over Telegram, so a kid with
   no account never gets a linked row — and therefore can never hold a masterclass seat,
   with or without staff help.

## Scope

Two features, decided together:

- **A. Self-registration for staff** — a leader/admin books a seat like any participant.
- **B. On-behalf registration** — `/regmc <ПІБ>`, admins for any visitor, leaders for their
  own team only.

**The complexity is entirely in B.** Staff have Telegram IDs, so A needs no schema change —
roughly 20 lines. Everything below about `subjectKey`, index migration and check-in adoption
exists only so B can serve a kid with no Telegram account. If this is revived under time
pressure, A is the seam to cut on.

## Decisions

| Question | Decision |
|---|---|
| Do staff take a real seat? | Yes. `mcSeats` counts them; one-МК-per-slot applies to them too. |
| Register a visitor who hasn't checked in? | Yes — this is the whole point; a phoneless kid otherwise can't attend. |
| Adopt registrations when that kid later checks in? | Yes, rewrite them onto the new account. |
| Entry point for on-behalf | Typed `/regmc <ПІБ>` only, documented in `/help` and the scoped command menus. |
| Target already registered for that slot | Refuse. No swap, no staff unregister path. |
| Notify the registered participant | No DM. Only the staff member sees the result. |
| Admin reply keyboard | Admins get the base visitor keyboard on `/start`. |

## Design

### 1. Registration identity: `subjectKey`

`MongoRegistration` gains `subjectKey`: `tg:<telegramId>` for anyone with an account
(participant or staff), `row:<rowIndex>` for a visitor who has not checked in. `telegramId`
stays as the *messaging* field and is empty for `row:` registrations — `/notifymc` and the
reminder cron already skip blanks, so they skip those people for free.

The unique partial index moves from `(date, slot, telegramId)` to `(date, slot, subjectKey)`,
both over `active: true`. The old index must be **dropped**, not merely supplemented: every
phoneless registration carries `telegramId: ""` and the second one in a slot would collide.

`ensureIndexes()` performs the whole migration idempotently — backfill `subjectKey` where
missing, drop the old index if present, create the new one. It is already called from
`/syncmc`, so the deploy order is **deploy, then `/syncmc`**. Until that runs, a second
phoneless registration in the same slot fails with a duplicate-key error.

`mcSeats` is untouched: counters are per `(date, slot, mcId)` and key-agnostic.
`hasActiveRegistrationForSlot` and `buildSlotButtons` (`src/masterclasses.ts`) take a
`viewerKey` instead of a `viewerTelegramId`.

### 2. Staff self-registration

`mcreg` keeps its current first step — look up the visitor row. **Only on a miss** does it
check staff status, via a new `loadStaffIdentity(id)` doing `Promise.all([loadAdmins(),
loadLeaders()])` (one batched Sheets request). Superadmins come from `config.adminIds`.
Putting the check after the miss keeps the common participant tap at zero Sheets reads
during a registration rush, which the 60-reads/minute camp-wide quota demands.

Staff register under `tg:<their id>`, take a real seat, and are bound by the same one-per-slot
index. Their display name is snapshotted onto the registration doc (`staffName`) at write
time, because they have no visitors-mirror row to resolve against: from `Admins.Name` /
`Leaders.Name`, falling back to `bot.api.getChat` for a superadmin with no sheet row.

Attendee-list name resolution order: mirror by `telegramId` → mirror by `rowIndex` (for `row:`
keys) → `staffName` → the existing «невідомий учасник».

Admins get the base visitor keyboard on `/start` (`keyboardFromRoles` learns `isAdmin`).

### 3. `/regmc <ПІБ>`

Gated to admins and leaders. Searches visitors with the existing `searchByName`; for a leader
the visitor list is filtered to their team(s) **before** searching, so a name outside their
team reads «не знайдено серед вашої команди» rather than exposing another team's roster. Top
5 matches render as `regpick:<rowIndex>` buttons.

Picking a person shows today's masterclass list built like `🎨 Майстер-класи`, with callbacks
`mcregfor:<date>:<slot>:<mcId>:<rowIndex>` (~40 bytes, under Telegram's 64-byte limit) and
their current registration marked ✅. The subject key is `tg:<id>` when that row has checked
in, `row:<rowIndex>` when it hasn't. On collision: «Оксана вже записана на "Розпис пряників"
о 12:00». On success only the staff member is told.

Carries the same rowIndex-staleness caveat as the existing `link_visitor:` check-in buttons —
a `/syncvisitors` between the pick and the tap shifts rows. Pre-existing precedent, not new.

### 4. Adoption at check-in

`linkAndCheckInMongo` (`src/visitor-store.ts`), after a successful link, rewrites that row's
active `row:<rowIndex>` registrations to `tg:<id>` and fills in `telegramId`. Per-document
with a try/catch rather than one `updateMany`, so a duplicate-key conflict (an account
released via `/fixcheckin` that already holds that slot) skips one registration instead of
aborting the rest. Best-effort and non-fatal, like the other check-in write-throughs.

### 5. Help, menus, strings

`roleCapabilitiesText()` (`src/messages.ts`) takes `isAdmin` and gains a `/regmc` line for the
leader and admin roles; `src/commands.ts` adds `/regmc` to the admin and leader scoped menus;
new user-facing strings go in `M`.

## Verification

No test suite. `npm run typecheck`, then a manual pass on the dev bot against a scratch
spreadsheet and a test Mongo:

1. Staff self-register and appear by name in the responsible's «👥 Учасники МК».
2. `/regmc` a phoneless kid; seat count drops; kid shows by name in the attendee list.
3. Check that kid in; confirm the registration adopts onto their account.
4. Run `ensureIndexes()` against a database that still has the old unique index.

## Known limitations (accepted)

- A `row:`-keyed registration cannot be cancelled by anyone until that kid checks in — staff
  have no unregister path and the kid has no account.
- No swap flow: correcting a wrong registration means waiting for check-in.
- The reminder cron does not chase staff; it iterates the visitors mirror.