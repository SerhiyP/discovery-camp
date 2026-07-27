# Phishing-Awareness "Caught" Tracking — Design

**Date:** 2026-07-27
**Status:** Approved for planning

## Goal

The presenter is running a live phishing-awareness masterclass: during the session they
send a lure message (a fake "free Steam balance", "account will be blocked", etc.) to the
masterclass's registered attendees, containing a link back into this bot. Clicking it
should quietly log who got caught, without spoiling the surprise, so the presenter can
reveal real names during the talk.

No new message-sending mechanism is needed — the presenter already has `/notifymc`, which
sends free-text to everyone registered for their MC occurrence today. They'll paste their
own lure text (any of their 3 prepared scenarios, or custom) containing a fixed link:

```
https://t.me/<BOT_USERNAME>?start=caught
```

This design covers only two things: what happens when that link is clicked, and how the
presenter views the catch list.

## Behavior

### 1. Click → `/start caught`

`bot.command("start", ...)` (`src/bot.ts:90-102`) already branches on payload (see the
existing `med_<id>` case). Add a `caught` branch, checked before the existing fallthrough:

- Log the catch: `logCatch(String(ctx.from!.id))`.
- Reply privately with a fixed reveal message, `M.phishCaught` — does not touch the
  visitor-linking/`welcome` flow below it.
- Every click is logged (no dedup at write time — see Edge cases for how repeats are
  handled at display time).

This works for both registered and non-registered clickers (e.g. a forwarded link); the
presenter's `/caught` view is what scopes results down to a specific MC's real attendees.

### 2. `/caught` — presenter's reveal command

New zero-arg command, gated and scoped exactly like `/notifymc`/`/mcattendees`:

1. `myOccurrencesToday(ctx.from!.id)` (`src/bot.ts:727`) — `null` → `M.notResponsible`;
   empty → `M.noMyMcToday`.
2. Load `loadMCRegistrations()` and `loadCatches()` (new, see below) in parallel.
3. For each occurrence (same "if exactly one, show directly; if multiple, offer a picker"
   shape as `/notifymc` — reuse the same `mn:<idx>`-style pattern rather than a second
   one):
   - `activeRegs(regs, o.date, o.slot, o.mc.id)` → attendee `telegramId`s for that
     occurrence.
   - Intersect with the catch log: for each attendee whose ID appears in `loadCatches()`,
     keep the **earliest** `caughtAt` for that ID.
   - Render `M.caughtHeader(mc.title, slot)` then one line per caught attendee:
     `• {name} — {caughtAt}` (name from the registration row, sorted by catch time), or
     `M.noCatches` if nobody from that occurrence has clicked yet.

Multiple occurrences today: reuse the existing picker shape (`InlineKeyboard` +
`mn:<idx>`-style callback) rather than inventing a second mechanism — a new callback
prefix `cn:<idx>` mirroring `mn:<idx>` (`src/bot.ts:790-808`), since `/caught` has no text
payload to re-embed in the message the way `/notifymc`'s picker does.

## Data model

New sheet tab `PhishCatches` (already created): `Telegram ID | Caught at`. No `rowIndex`
lookups/deletes needed — this is an append-only log, never edited or cleared through the
bot.

### `src/phishing.ts` (new file)

Mirrors the shape of `src/admins.ts`:

```ts
import { config, nowStamp } from "./config";
import { appendRow, getRows, headerIndex } from "./sheets";

export interface PhishCatch {
  telegramId: string;
  caughtAt: string;
}

export async function logCatch(telegramId: string): Promise<void> {
  await appendRow(config.phishCatchesTab, [telegramId, nowStamp()]);
}

export async function loadCatches(): Promise<PhishCatch[]> {
  const rows = await getRows(config.phishCatchesTab);
  if (rows.length === 0) return [];
  const header = rows[0];
  const idCol = headerIndex(header, "Telegram ID");
  const atCol = headerIndex(header, "Caught at");
  const catches: PhishCatch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const telegramId = (rows[i][idCol] ?? "").trim();
    if (!telegramId) continue;
    catches.push({ telegramId, caughtAt: (rows[i][atCol] ?? "").trim() });
  }
  return catches;
}
```

`config.ts`: add `phishCatchesTab: "PhishCatches"` alongside the other tab constants
(`src/config.ts:36-41`).

## `src/messages.ts`

```ts
phishCaught: "🎣 Ви попались! Це був навчальний фішинг — обговоримо це на майстер-класі.",
caughtHeader: (title: string, slot: string) => `Спіймані на «${title}» (${slot}):`,
noCatches: "— поки ніхто не попався",
```

`M.notResponsible` and `M.noMyMcToday` (existing) are reused unchanged.

## `src/commands.ts`

No change. `commands.ts` only has menu groups for `user`/`leader`/`admin`/`superadmin` —
there's no "responsible" tier, so neither `/notifymc` nor the `👥 Учасники МК` button's
handler (`handleMcAttendees`, reply-keyboard-only, not a typed command at all) appear in
any menu today. `/caught` follows `/notifymc`'s existing precedent: a typed-only command,
gated at runtime by `myOccurrencesToday`, with no slash-menu entry.

## Out of scope

- Building or sending the lure messages themselves — that stays entirely in the
  presenter's hands as free text through `/notifymc`.
- Distinguishing which of the 3 scenarios caught someone (decided against — one generic
  link for all scenarios).
- Any UI for authoring/storing scenario templates in the bot.
- Rate-limiting or deduping `logCatch` writes — a person clicking the link 5 times just
  produces 5 rows; display-time dedup (earliest timestamp) handles it cheaply enough for
  camp scale.

## Edge cases

- Non-attendee clicks the link (forwarded, or clicked out of curiosity): still logged in
  `PhishCatches`, but never shown in `/caught` since that view only lists people found in
  `activeRegs` for the presenter's own occurrence.
- Repeat clicks by the same person: logged every time; `/caught` shows them once, using
  their earliest `caughtAt`.
- Presenter runs `/caught` before anyone has clicked: `M.noCatches` per occurrence, not an
  empty/broken message.
- Multiple MC occurrences today for the same responsible person: picker shown first
  (mirrors `/notifymc`'s existing multi-occurrence flow), same as described above.
- `BOT_USERNAME` env var already exists (`config.botUsername`, used for the existing
  `med_<id>` deep link at `src/bot.ts:172`) — no new env var needed; the presenter builds
  the `t.me/<BOT_USERNAME>?start=caught` link manually when writing their lure text.

## Verification

`npm run typecheck` must pass. Manual check after `npx vercel --prod` (no tests/local dev
server, per existing convention): click the deep link yourself, confirm a private
`M.phishCaught` reply and a new `PhishCatches` row; run `/caught` as the MC's responsible
person and confirm your name/time shows up; confirm a second click doesn't duplicate the
displayed entry.
