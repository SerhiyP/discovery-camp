# Check-in message polish: split prompt, info channel, special needs

**Date:** 2026-08-02
**Status:** Approved, ready for implementation

## Problem

Three unrelated rough edges in the check-in experience:

1. `/start` sends the greeting, the "тут можна…" capability list, and the
   "напишіть своє прізвище" instruction as one wall of text. The instruction —
   the only part that asks for an action — is the easiest to skim past.
2. There is a Telegram channel with important camp information, and nothing in
   the bot points at it.
3. The Google Form asks «Особливі потреби» (allergies, medical conditions,
   dietary notes). Nobody in the bot can see that column: not the doctor who
   scans a participant's QR at the medical check, not the team leader who is
   responsible for that participant all week.

## Scope

Four changes, all in `src/messages.ts`, `src/bot.ts`, `src/checkin.ts`,
`src/config.ts`. No sheet schema changes — the «Особливі потреби» column
already exists in `Form Responses 1`.

---

### 1. `askName` becomes its own message

`M.welcome` currently ends with:

> Щоб почати, відмітьтесь на реєстрації — напишіть своє прізвище та ім'я, так,
> як ви вказували їх у формі реєстрації.

Drop that sentence from `M.welcome`. In the unlinked branch of `/start`, send
two messages instead of one:

1. `M.welcome` — greeting + `GENERAL_INFO`. Carries the reply keyboard, exactly
   as today (a leader who never checked in as a visitor still gets their
   buttons repaired here).
2. `M.askName` — already defined in `messages.ts` but currently dead code. This
   change is what puts it to use.

The `alreadyLinked` branch is untouched and stays a single message.

### 2. Info-channel link

New string:

```ts
infoChannel:
  "📢 Важлива інформація про табір:\n" +
  "https://t.me/c/3954616904/266",
```

Plain URL, no `parse_mode` — Telegram auto-links it. The `t.me/c/` form usually
means a private channel, but this one was checked and opens for non-members too,
so no invite link is needed.

Two call sites, deliberately formatted differently:

- **`sendFinalMessage`** — a standalone message. New order:
  `registrationComplete` (carries the keyboard) → `roleCapabilitiesText` →
  `M.infoChannel` → team video.
- **`/help`** — appended to the same message:
  `${roleCapabilitiesText(roles)}\n\n${M.infoChannel}`.

`roleCapabilitiesText()` itself stays link-free. Baking the link into it would
make it print twice in a row during check-in.

### 3. Doctor scan shows «Особливі потреби» verbatim

Plumbing:

- `config.ts` — add `specialNeedsHeader: "Особливі потреби"`.
- `checkin.ts` — add `specialNeeds` to `Visitor` and to `VisitorSheet["cols"]`.
  Read as an optional column, the same shape as `team`/`room`: a missing header
  yields `-1` and an empty string rather than throwing.

In `handleDoctorScan`, the confirmation to the scanning admin becomes two lines:

```
✅ Кирилкова Злата — медогляд відмічено
🩺 Особливі потреби: Епілепсія в мене але я приймаю ліки
```

Value is shown **verbatim and unconditionally**, filler included — a doctor
seeing `Особливі потреби: Ні` knows the question was answered, whereas a
missing line is ambiguous between "nothing to report" and "the bot dropped it".
Empty cell renders as `—`.

This is display-only: no change to what gets written to the sheet, and the
participant never sees this line. The `medAlreadyDone` re-scan branch is
**not** changed.

### 4. Meaningful needs in the leader team roster

`👥 Моя команда` gains an indented warning line under any member whose
«Особливі потреби» survives the filler filter:

```
👥 Команда 3 — 12 учасників
1. Кирилкова Злата — 13 р. · 🚪 6.3
2. Куценко Оксана — 14 р. · 🚪 6.6
   ⚠️ Епілепсія в мене але я приймаю ліки
3. Федорчук Софія — 13 р. · 🚪 6.3
   ⚠️ алергія на моркву
```

`teamRosterLine` gains a `needs` argument and emits the second line only when
`needs` is non-empty.

**Filler filter.** A new helper — `isMeaningfulNeed(s)` in `checkin.ts`,
next to the other normalization code — normalizes the value (lowercase, strip
apostrophes/punctuation, collapse whitespace) and drops it if it **exactly**
equals a known filler:

```
ні · немає · не має · нема · відсутні · відсутнє · не виявлено
ні немає · немає ніяких проблем · немає жодних проблем · - · — · (blank)
```

Exact-match-only is deliberate. `Алергії не виявлено, потреба в
самодисципліні` contains a filler phrase but carries real content after it, so
it survives and is shown. The cost of the filter erring toward showing is a
noisy line; the cost of erring toward hiding is a leader not knowing about a
medical condition.

Unlike the doctor path, this one filters — a leader reads the whole roster at
once, and 12 lines of `⚠️ Ні` would train them to skip the warnings.

**Privacy note.** This puts medical free-text in front of team leaders. That is
intended: leaders are responsible for their team all week. Worth stating
explicitly because `👥 Моя команда` is a button any linked leader can press,
with no further confirmation.

## Non-goals

- No proactive push of the channel link to already-registered participants.
- No change to `registrationComplete` — the link is a separate message, and its
  existing lines stand as they are.
- No new admin command for viewing needs; the doctor QR and the leader roster
  are the only two surfaces.

## Verification

`npm run typecheck` must pass. Manual smoke test against the dev bot
(`npm run dev`, test spreadsheet):

1. `/start` as an unlinked user → two messages, second is the name prompt.
2. Complete a check-in through doctor + Аня → final message, capabilities,
   channel link, video, in that order.
3. `/help` → one message ending with the channel link.
4. Scan a participant's med QR as an admin → confirmation carries the needs
   line, including for a participant whose cell reads `Ні`.
5. Press `👥 Моя команда` as a leader of a team containing both a filler and a
   real needs value → only the real one shows a `⚠️` line.
