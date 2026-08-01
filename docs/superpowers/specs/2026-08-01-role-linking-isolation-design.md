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

`bot.command("leader")` (`src/bot.ts:152-159`) keeps its already-linked guard and gains two
entry shapes:

- **`/leader <ПІБ>`** — arguments present: search Leaders immediately with that text.
- **`/leader`** — bare: reply `M.leaderPrompt` with `reply_markup: { force_reply: true }`.
  The user's reply is what carries the name.

Both paths funnel into one helper that searches **only** `searchLeaderByName` and replies
with the existing message shapes:

- exactly one match → `M.confirmLeader(name, team)` + a single `link_leader:<rowIndex>`
  button;
- several matches → `M.chooseYourself` + one `👑 <name> (<team>)` button per match;
- none → `M.leaderNotFound`.

The `link_leader:` callback (`src/bot.ts:238-273`) is unchanged.

### 2. `/responsible` — new, mirrors `/leader`

New command with the identical two entry shapes (`/responsible <ПІБ>` and bare +
`force_reply`), guarded by `findResponsibleByTelegramId` and searching only
`searchResponsibleByName`:

- already linked → `M.respAlreadyLinked` (new message);
- bare invocation → `M.respPrompt` (new message) with `force_reply`;
- one match → `M.confirmResp(name)` + `link_resp:<rowIndex>`;
- several → `M.chooseYourself` + one `🎨 <name>` button per distinct person (keep the
  existing dedup-by-lowercased-name so one button links all of that person's MC rows);
- none → `M.respNotFound`.

The `link_resp:` callback (`src/bot.ts:275-302`) is unchanged, including its
"link every unlinked row with this name" behavior.

Typed-only, no slash-menu entry — same precedent as `/leader` and `/notifymc`
(see `src/commands.ts:12-17`, where `/leader` is deliberately absent).

### 3. Reply detection (stateless)

Vercel serverless keeps no session state, so the reply itself carries the context. In the
existing `bot.on("message:text")` handler, before any search:

```ts
const repliedTo = ctx.message.reply_to_message?.text;
if (repliedTo === M.leaderPrompt) return handleLeaderNameSearch(ctx, ctx.message.text);
if (repliedTo === M.respPrompt) return handleRespNameSearch(ctx, ctx.message.text);
```

Comparing against the exact prompt strings is sufficient: both are fixed constants in
`M`, and a `force_reply` prompt is the only message a user would be replying to with a
name. This keeps a single text entry point, which is why the branch lives inside the
existing handler rather than in a second `bot.on("message:text")` that would need
`next()` chaining.

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

Two new strings, placed next to the existing responsible block (`src/messages.ts:100-106`):

```ts
respPrompt:
  "Це вхід для відповідальних за майстер-класи. Напишіть своє прізвище та ім'я — так, як вас зареєстрував адміністратор.",
respAlreadyLinked: (name: string) =>
  `Ви вже підключені як відповідальний за майстер-клас (${name}) ✅`,
```

`M.leaderPrompt`, `M.confirmLeader`, `M.confirmResp`, `M.chooseYourself`,
`M.leaderNotFound`, `M.respNotFound`, `M.leaderAlreadyLinked` are reused unchanged.

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

- **User dismisses the `force_reply` composer** and types their name as a plain message:
  it falls through to the visitor search, so they get a visitor result or `M.notFound`.
  The `/leader <ПІБ>` / `/responsible <ПІБ>` argument form is the documented escape hatch,
  which is why both entry shapes exist.
- **Reply arrives after the row was claimed by someone else** in between: the search
  returns no unlinked match → `M.leaderNotFound` / `M.respNotFound`; if the user replies to
  a stale button, `link_leader:` / `link_resp:` still answer `M.rowTaken`.
- **Someone already linked as a visitor runs `/leader`**: allowed — the guard only blocks
  re-linking an *already-linked leader* account. This is the deliberate two-step path.
- **Reply text matches a reply-keyboard button label**: `bot.hears` is registered before
  the text handler and wins. Harmless — the user re-runs the command.
- **Responsible person with several MC rows**: unchanged; one confirm button links all of
  their unlinked rows via `linkResponsibleRows`.

## Verification

No test suite and no local dev server in this repo. `npm run typecheck` must pass, then a
manual pass after `npx vercel --prod`:

1. Type a known leader's name as a plain message → only visitor results (or `M.notFound`);
   **no** `👑` button appears.
2. `/leader` → reply with that name → confirm button → linked, leader keyboard appears.
3. `/responsible <ПІБ>` → confirm button → linked, responsible keyboard appears.
4. Re-run `/leader` while linked → `M.leaderAlreadyLinked`; re-run `/responsible` while
   linked → `M.respAlreadyLinked`.
5. From a second account, `/leader` with the same now-claimed name → `M.leaderNotFound`.
