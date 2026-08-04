# /fixcheckin: release a wrongly-claimed check-in — Design

**Date:** 2026-08-04
**Status:** Approved for planning

## Goal

Check-in links a Telegram account to a visitor row by name (`link:` callback → `linkAndCheckInMongo`,
`src/visitor-store.ts:137`). Two people with similar names can pick each other's rows — a *swap* — or
one person can simply tap the wrong button. The guard is one-way: once a row holds a `telegramId`,
anyone else who picks it gets `M.rowTaken` and is stuck. Nothing in the codebase can release a link.

Add an admin command that releases a wrongly-claimed row so the right person can check in normally.

## Behavior

`/fixcheckin <ПІБ | Telegram ID>` — admin and superadmin only (`isAdmin` gate, same as `/delresp`).
Not registered in the slash menu (`src/commands.ts`): it takes an argument, and menu entries send
instantly with none.

### Lookup

The argument is dispatched on its shape:

- **Pure digits, length ≥ 5** → Telegram ID. Resolves to the single row that account holds via
  `findVisitorByTelegramIdMongo`. This is the "other end" of a swap: fixable from the desk when the
  admin has the person in front of them but not the misclaimed name.
- **Anything else** → name query. `searchByName` (`src/checkin.ts:117`) over `getVisitorsMongo()` —
  Mongo, not Sheets, because Mongo is authoritative for the link and this costs no Sheets quota.
- **Empty** → usage hint, no search.

### Picker

One message listing every match (`searchByName` already caps at 5), each rendered as a block:

```
📋 Знайдено 2:

1. Петренко Іван Миколайович
   Команда 3 · Кімната 12
   ✅ Відмічений 2026-08-04 09:14
   👤 Telegram ID: 123456789
   🩺 Медогляд пройдено

2. Петренко Івана Миколаївна
   Команда 3 · Кімната 7
   ⬜ Не відмічена
```

- Sent with `parse_mode: "HTML"`; the Telegram ID is wrapped in `<code>` so the admin can tap to copy
  it — the whole point of showing it is diagnosing a swap by comparing IDs across two rows.
- Unlinked rows are still listed (so the admin can see the ID they are hunting is *not* there) but
  get no button.
- One inline button per **linked** row: `♻️ Скасувати чек-ін: <name>`, callback `fixci:<rowIndex>`.
  Button labels are truncated to keep the row readable; `rowIndex` is a small integer, so the 64-byte
  callback-data limit is not a concern.

### Confirm and release

Tapping a button edits the message to a confirm screen: the same row detail plus
`✅ Так, скасувати` (`fixciyes:<rowIndex>`) / `↩️ Скасувати` (`fixcicancel`). Cancel rebuilds nothing —
it edits to a short "дію скасовано" text, since rebuilding the picker would need the original query.

Confirming:

1. Calls `releaseCheckInMongo(rowIndex)`, which re-reads the doc itself.
2. `undefined` back (row missing, or someone else already fixed it) → edits to «цей рядок уже
   вільний»; nothing was written.
3. Otherwise DMs the released account (best effort) and edits the admin's message to a result that
   states the released name, the released Telegram ID, and whether the DM landed.

All three callback handlers answer through `safeAnswer()` and are wrapped in `mongoGuarded`.

## Data model

No schema change. One new function in `src/visitor-store.ts`, placed next to `linkAndCheckInMongo` —
it is the exact inverse:

```ts
/** Releases a wrongly-claimed row so the right person can check in. Returns the
 *  visitor as it was before the release (the caller needs the old telegramId to
 *  notify that account), or undefined if the row is missing or already free.
 *  doctorStatus is deliberately kept — see "Design notes". */
export async function releaseCheckInMongo(rowIndex: number): Promise<Visitor | undefined>
```

It `$set`s `telegramId: ""` and `checkedIn: ""` on that `_id`. **Mongo only** — the sheet's
`Checked in`/`Telegram ID` columns have not been written since the 2026-08-03 migration and stay
untouched here too.

Deliberately not touched:

| Thing | Why |
|---|---|
| `doctorStatus` | Kept — see "Design notes". |
| MC registrations | Keyed by `telegramId` with names resolved at read time (`src/mc-store.ts:126`), so they follow the person, not the row, and re-resolve correctly once that person checks in under their own name. |
| `mcSeats` counters | No registration is cancelled, so no counter moves. |
| Leaders / MCResponsible rows | Separate tables with their own link commands (`/leader`, `/responsible`). |

## Notifying the released account

Sent with `bot.api.sendMessage(oldTelegramId, ...)` inside a `try/catch` — the account may have
blocked the bot, and a failed DM must not abort a release that already committed.

The message carries `reply_markup: { remove_keyboard: true }` so the now-invalid visitor buttons
disappear immediately, rather than failing one at a time on the next tap — the same reasoning as
`replyRoleRevoked` (`src/bot.ts:131`).

After the release, that account's `/start` finds no row and asks for a name, so the existing check-in
flow handles the rest. No new check-in path is added.

## `src/messages.ts`

New keys (Ukrainian, alongside the existing admin block):

```ts
fixCheckinUsage: "Вкажіть ПІБ або Telegram ID: /fixcheckin Петренко Іван",
fixCheckinNotFound: "Нікого не знайдено. Спробуйте частину імені або Telegram ID.",
fixCheckinFound: (n: number) => `📋 Знайдено ${n}:`,
// one numbered block of the picker; also reused verbatim by the confirm screen
fixCheckinRow: (n: number, v: Visitor) => string,   // HTML, <code> around the ID
fixCheckinBtn: (name: string) => `♻️ Скасувати чек-ін: ${name}`,
fixCheckinConfirm: (block: string) => `${block}\n\nСкасувати чек-ін цієї людини?`,
fixCheckinAlreadyFree: "Цей рядок уже вільний — чек-ін скасовано раніше.",
fixCheckinDone: (name: string, id: string, notified: boolean) => string,
fixCheckinCancelled: "Дію скасовано.",
fixCheckinReleasedDm: "Ваш чек-ін було скасовано адміністратором. Натисніть /start і вкажіть своє ім'я.",
```

## `src/bot.ts`

- `bot.command("fixcheckin", ...)` — admin gate, argument dispatch, picker.
- A local `buildFixCheckinPicker(query)` helper returning `{ text, kb } | null`, mirroring
  `buildDelRespPicker`, so the command handler stays thin.
- `bot.callbackQuery(/^fixci:(\d+)$/)` — confirm screen.
- `bot.callbackQuery(/^fixciyes:(\d+)$/)` — release + DM + result.
- `bot.callbackQuery(/^fixcicancel$/)` — "дію скасовано".

## Design notes

**`doctorStatus` is kept on the released row.** In the swap case — the motivating one — both people
really were examined by the doctor, each having scanned their own QR while holding the other's row,
so both rows carry a mark that a real exam produced. Clearing it would send both back through the
medical queue for nothing. For a single wrong pick (not a swap) this does leave the row with a mark
the eventual participant did not earn; the confirm screen shows `🩺 Медогляд пройдено`, so the admin
sees it and can send that person to the doctor. No "also clear doctor status" option is added.

**Access is admin-only, by name.** Self-service release was considered and rejected: a "це насправді
я" button offered to whoever hits `M.rowTaken` can be tapped by the impostor as readily as by the
victim, and a release is destructive.

## Out of scope

- **Direct transfer** between two rows in one step. Release + normal re-check-in covers it with no
  new check-in path.
- **Repairing `/syncvisitors`.** `syncVisitorsFromSheets` (`src/visitor-store.ts:43`) does
  `deleteMany({})` and re-inserts `telegramId`, `checkedIn` and `doctorStatus` **from the sheet** —
  but nothing has written those columns to the sheet since 2026-08-03. Running `/syncvisitors` today
  wipes every check-in, link and doctor mark recorded since then, and would equally undo or resurrect
  a `/fixcheckin` release. This is a pre-existing hazard, not caused by this feature; it needs its own
  fix and its own spec. Flagged here because it is the one thing that can silently reverse a
  correction.
- **Dead code removal.** `checkin.ts:linkAndCheckIn` (the Sheets-writing original) is now referenced
  only from a comment. Not touched here.
- **Audit log** of who released what. The admin's result message is the only record.

## Edge cases

- Row already unlinked when the confirm button is tapped → `fixCheckinAlreadyFree`, no write.
- Name matches nobody, or the ID holds no row → `fixCheckinNotFound`.
- All matches unlinked → they are listed, with no buttons and no confirm step.
- Admin releases their own row → allowed, no special case; they re-check-in like anyone.
- Expired callback query → `safeAnswer()` logs instead of throwing; the release still commits and the
  admin still gets a real message, per the standing rule in `CLAUDE.md`.
- Mongo unavailable → `mongoGuarded` replies «спробуйте за хвилину» instead of a 500 that Telegram
  would redeliver.
- Non-admin runs the command → `M.notAdmin`.

## Verification

`npm run typecheck` must pass. Manual, against the dev bot and a scratch spreadsheet
(`npm run dev`):

1. Check in as account A under name X. Confirm account B picking X gets `M.rowTaken`.
2. `/fixcheckin X` as an admin — the picker shows A's Telegram ID and the check-in stamp.
3. Confirm the release; verify A receives the DM with its keyboard removed, and that the admin's
   result message reports the DM as delivered.
4. Account B now checks in as X successfully; account A's `/start` asks for a name again.
5. In Mongo, verify the row's `doctorStatus` survived the release while `telegramId`/`checkedIn` are
   empty.
6. `/fixcheckin <A's id>` before step 3 resolves to the same row as the name search.
