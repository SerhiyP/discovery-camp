# Command-Gated Leader/Responsible Linking — Design

**Date:** 2026-08-01
**Status:** Approved for planning

## Goal

Today a plain text message triggers a search across **three** tables at once — Visitors,
Leaders, and MCResponsible (`src/bot.ts:916-965`). If the typed name happens to match an
unlinked Leader or Responsible row, the bot offers to link that identity too, even to
someone who was only trying to do a normal visitor check-in.

Two problems follow from that:

1. **Roles leak into the visitor flow.** A leader is meant to be *only* a leader; a
   responsible person is meant to be *only* responsible (plus, optionally, admin — that
   tier is keyed by Telegram ID, not by name, so it is unaffected). The current flow
   actively invites the combined-role case by offering both buttons side by side.
2. **Name-guessing surface.** Any visitor typing a leader's name is shown a
   `👑 <Name> (<team>)` button and can claim that identity in one tap.

The fix: leader and responsible linking become **opt-in, command-gated** flows. The
generic text handler goes back to searching only the Visitors table.

Note on what is *already* safe and stays unchanged: a row that has a Telegram ID can never
be re-claimed or overwritten. `searchLeaderByName`/`searchResponsibleByName` filter to
`!telegramId` (`src/leaders.ts:55-65`, `src/responsible.ts:59-69`), and the link callbacks
reject a row belonging to a different account with `M.rowTaken` (`src/bot.ts:253-256`,
`src/bot.ts:284-287`). `linkAndCheckIn` does the same for visitors
(`src/checkin.ts:119-120`). No changes are needed there.

## Behavior

### 1. `/leader` — gated leader linking

`bot.command("leader")` (`src/bot.ts:152-159`) keeps its already-linked guard and takes the
name as a command argument:

- **`/leader`** (bare) → reply `M.leaderPrompt`, reworded into a usage hint that shows the
  exact command format.
- **`/leader <ПІБ>`** → search Leaders with `ctx.match.trim()`.

The name-carrying path searches **only** `searchLeaderByName` and replies with the existing
message shapes:

- exactly one match → `M.confirmLeader(name, team)` + a single `link_leader:<rowIndex>`
  button;
- several matches → `M.chooseYourself` + one `👑 <name> (<team>)` button per match;
- none → `M.leaderNotFound`.

The `link_leader:` callback (`src/bot.ts:238-273`) is unchanged.

### 2. `/responsible` — new, mirrors `/leader`

New command with the identical shape, guarded by `findResponsibleByTelegramId` and
searching only `searchResponsibleByName`:

- already linked → `M.respAlreadyLinked` (new message);
- bare invocation → `M.respPrompt` (new message), a usage hint showing the command format;
- one match → `M.confirmResp(name)` + `link_resp:<rowIndex>`;
- several → `M.chooseYourself` + one `🎨 <name>` button per distinct person (keep the
  existing dedup-by-lowercased-name so one button links all of that person's MC rows);
- none → `M.respNotFound`.

The `link_resp:` callback (`src/bot.ts:275-302`) is unchanged, including its
"link every unlinked row with this name" behavior.

Typed-only, no slash-menu entry — same precedent as `/leader` and `/notifymc`
(see `src/commands.ts:12-17`, where `/leader` is deliberately absent).

### 3. Why the argument form, for both commands

Carrying the name in the command itself means each linking attempt is a single self-
contained update. Nothing has to be remembered between messages — which matters on Vercel
serverless, where no session state survives between updates — and the text handler needs
no new branch at all. This is what keeps the change small: one guard plus one search per
command, and a strict deletion in the generic handler.

### 4. Generic `message:text` handler

- Drop the unconditional `searchLeaderByName` / `searchResponsibleByName` calls and the
  `respMatches` dedup — those move into the gated helpers above.
- Keep the visitor search exactly as-is, including the "skip if already linked as a
  visitor" guard.
- Keep loading leaders/responsible **only** for the already-linked fallback messages when
  there is no visitor match: existing `meLeader` → `M.leaderAlreadyLinked`, then a new
  `meResponsible` → `M.respAlreadyLinked`, then existing `meVisitor` → `M.alreadyLinked`,
  then `M.notFound`. Order is otherwise unchanged.
- The three single-match/multi-match branches collapse to the visitor case only.

Net effect: a leader can still *also* check in as a camper (room, medical, masterclass
registration) — but only through two separate deliberate actions (`/leader` once; typing
their name normally another time), never as one auto-combined offer.

## `src/messages.ts`

`M.leaderPrompt` is reworded from "напишіть своє прізвище та ім'я" into a usage hint that
names the command, since a bare message no longer reaches the leader search:

```
Це вхід для лідерів команд. Надішліть команду разом зі своїм прізвищем та іменем — так, як вас зареєстрував адміністратор:

/leader Прізвище Ім'я
```

Two new strings, placed next to the existing responsible block (`src/messages.ts:100-106`),
`respPrompt` following the same usage-hint shape:

```
Це вхід для відповідальних за майстер-класи. Надішліть команду разом зі своїм прізвищем та іменем — так, як вас зареєстрував адміністратор:

/responsible Прізвище Ім'я
```

```
respAlreadyLinked(name) -> `Ви вже підключені як відповідальний за майстер-клас (${name}) ✅`
```

`M.confirmLeader`, `M.confirmResp`, `M.chooseYourself`, `M.leaderNotFound`,
`M.respNotFound`, `M.leaderAlreadyLinked` are reused unchanged.

## No changes

- `src/keyboards.ts` — `roleKeyboard()` keeps the base visitor buttons for every role.
  Those buttons (Майстер-класи / Розклад / Мої реєстрації) are what a leader or
  responsible person uses to see the camp schedule; they are not evidence of a visitor
  *link* and are unrelated to this fix.
- `src/leaders.ts`, `src/responsible.ts`, `src/checkin.ts` — search and link primitives are
  already correct.
- `src/commands.ts` — no menu entry for either command.
- The `Leaders` sheet's stray label row (`№ групи | Колір браслетів | Наставники`) that
  surfaced this discussion is a data issue, fixed by deleting spreadsheet row 2 by hand.
  No code guard for it.

## Docs

- `README.md`: drop the two "може бути одночасно" notes (lines 37 and 49); document
  `/responsible` alongside `/leader` in the responsible section, and state that linking a
  second role requires running that role's own command.
- `CLAUDE.md`: update the Role system section so "Independent of the leader role; a person
  can hold both" reflects that combining roles now takes two deliberate commands rather
  than one merged offer.

## Out of scope

- Any server-side identity verification beyond the existing "row already taken" guard —
  explicitly decided against a check tying a Leader row to the claimant's checked-in team
  number.
- Admin/superadmin tiers: keyed by Telegram ID in `Admins`/`ADMIN_IDS`, never by typed
  name, so they combine freely with any role and are untouched here.
- Unlinking or transferring an already-claimed role (still admin-only, via
  `/removeleader` / `/delresp`).

## Edge cases

- **User sends a bare `/leader` and then their name as a separate message**: the name falls
  through to the visitor search, so they get a visitor result or `M.notFound`. This is why
  `M.leaderPrompt` must show the literal `/leader Прізвище Ім'я` format rather than saying
  "напишіть своє прізвище та ім'я" — the old wording would now lead the user into exactly
  this dead end.
- **Row claimed by someone else between the search and the tap**: `link_leader:` /
  `link_resp:` still answer `M.rowTaken`; a fresh `/leader <ПІБ>` returns
  `M.leaderNotFound` / `M.respNotFound` because the search skips linked rows.
- **Someone already linked as a visitor runs `/leader`**: allowed — the guard only blocks
  re-linking an *already-linked leader* account. This is the deliberate two-step path.
- **Responsible person with several MC rows**: unchanged; one confirm button links all of
  their unlinked rows via `linkResponsibleRows`.

## Verification

No test suite and no local dev server in this repo. `npm run typecheck` must pass, then a
manual pass after `npx vercel --prod`:

1. Type a known leader's name as a plain message → only visitor results (or `M.notFound`);
   **no** `👑` button appears.
2. Bare `/leader` → usage hint naming the `/leader Прізвище Ім'я` format.
3. `/leader <ПІБ>` → confirm button → linked, leader keyboard appears. Likewise
   `/responsible <ПІБ>` → linked, responsible keyboard appears.
4. Re-run `/leader` while linked → `M.leaderAlreadyLinked`; re-run `/responsible` while
   linked → `M.respAlreadyLinked`.
5. From a second account, `/leader` with the same now-claimed name → `M.leaderNotFound`.
