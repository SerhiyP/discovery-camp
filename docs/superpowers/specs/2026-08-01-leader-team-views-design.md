# Leader team views — design

Two read-only reply-keyboard buttons that let a team leader see their own team:
the roster with ages, and today's masterclass registrations.

## Motivation

Leaders currently have no way to see who is on their team. The data already
exists in `Form Responses 1` (name, age, team number) and `EventRegs`
(masterclass registrations), but the bot only exposes it to admins and
responsible people.

## Scope

**In:** team roster (name + age), today's per-slot masterclass registrations for
the team, both leader-only, both read-only.

**Out:** payment status, doctor status, room, check-in status, other days,
sorting options, export, editing anything.

## User interface

Buttons only — no slash commands and no command-menu entries. Both views take no
arguments, so `bot.hears()` on the button text is the whole entry point (same
shape as `👥 Учасники МК`). Typed `/team` and `/teammc` commands are deliberately
not registered.

The leader keyboard gains one row, placed above the existing leader actions:

```
🎨 Майстер-класи        🗓 Розклад
        📋 Мої реєстрації
👥 Моя команда      🎨 МК команди      ← new
     📢 Сповістити команду
   ✏️ Перейменувати команду
```

Responsible rows continue to stack below for people holding both roles.

### `👥 Моя команда`

```
Команда 3 — 7 учасників

1. Глевич Ульяна — 13 р.
2. Кирилкова Злата — 13 р.
3. Коваленко Анна — 11 р.
…
```

Sorted alphabetically by name (`localeCompare("uk")`) — sheet order is form
submission order and carries no meaning. A member with a blank `вік` cell shows
as name only, with no dash.

### `🎨 МК команди`

Every team member appears under every one of today's slots, so gaps are visible
without cross-referencing:

```
Команда 3 — МК сьогодні

12:00-13:00
• Глевич Ульяна — Кулінарія
• Кирилкова Злата — Кераміка
• Коваленко Анна — без реєстрації

14:00-15:00
• Глевич Ульяна — без реєстрації
• Кирилкова Злата — Робототехніка
• Коваленко Анна — Кулінарія
```

`без реєстрації` is used rather than a gendered `ще не обрав/обрала` — the sheet
records no gender and it cannot be inferred from a name.

Slots come from `MCSchedule` filtered to `todayISO()`, in sheet order. Members
are sorted alphabetically within each slot, matching the roster.

## Data flow

Team membership: `Leaders.Team` for the caller's rows, matched against the
visitor's `Номер команди` cell. This is the same string match `renameVisitorTeams`
and `renameLeaderTeams` already keep in sync.

Masterclass join: `EventRegs.Telegram ID` → `Form Responses 1.Telegram ID`.
Registering requires being linked, so the join is exact and needs no name
fallback. A member who never checked in has no Telegram ID and therefore always
reads as `без реєстрації` — which is the correct signal for a leader.

Sheets reads per press: 2 for the roster (`loadVisitors`, `loadLeaders`), 4 for
the MC view (plus `loadMCTabRows`, `loadMCRegistrations`). Same order as existing
handlers; no caching is introduced.

## Components

| File | Change |
|---|---|
| `src/checkin.ts` | Add `age` to `Visitor` and `cols` (wires up the already-declared but unused `config.age`); add `visitorsByTeam(visitors, team)` returning members sorted by name |
| `src/keyboards.ts` | Add `BTN.teamRoster` / `BTN.teamMc`; emit the new row inside the `opts.leader` branch, before the notify/rename rows |
| `src/messages.ts` | New strings: roster header, roster line, MC header, slot header, MC member line, no-registration marker, empty-team and no-slots-today cases |
| `src/bot.ts` | `handleTeamRoster` and `handleTeamMc`, both registered with `bot.hears()` before `bot.on("message:text")`; output via the existing `replyChunked` |

`visitorsByTeam` belongs in `checkin.ts` because that module already owns visitor
loading and the team column. No new module is warranted for two small handlers.

## Error and edge cases

- **Caller is not a leader** — `findLeadersByTelegramId` returns empty → reply
  `M.notLeader`. Same guard as `/notifyteam`.
- **Leader of multiple teams** — one section per team in a single reply, teams in
  `Leaders` sheet order, deduplicated by team value.
- **Team has no members** — section header followed by `У команді немає учасників`.
- **No slots scheduled today** — `Сьогодні майстер-класів немає`, no per-team
  sections.
- **Registration referencing an unknown MC ID** — the catalog lookup misses, so
  the member is rendered as `без реєстрації` rather than showing a bare ID.
- **Long output** — `replyChunked` (3500-char chunks) handles a large team or a
  multi-team leader. Chunk boundaries fall between lines, so a slot header can be
  separated from its members; acceptable, and the existing `/syncresp` report has
  the same property.
- **No global `bot.catch`** — an uncaught throw becomes an HTTP 500 that Telegram
  retries. Both handlers are read-only, so a retry is harmless.

## Verification

The repo has no test framework, so verification is `npm run typecheck` plus
manual exercise through `npm run dev` against a scratch spreadsheet:

1. Leader of one team presses both buttons — roster sorted, ages present, MC view
   shows one line per member per slot.
2. Member with a blank `вік` renders without a dash.
3. Member with no Telegram ID reads `без реєстрації` in every slot.
4. Non-leader pressing the button text gets `M.notLeader` and does not fall
   through to name search.
5. Leader of two teams gets two sections.
6. A day with no scheduled slots gives the no-slots message.

## Documentation

`CLAUDE.md` — add both buttons to the reply-keyboard table's Leader row and note
the leader team views in the role system section.