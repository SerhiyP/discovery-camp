# Leader Team Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give team leaders two reply-keyboard buttons — a team roster with ages, and today's masterclass registrations for their team.

**Architecture:** Both are read-only handlers in `src/bot.ts` that follow the existing `handleMcAttendees` shape: resolve the caller's role from the `Leaders` sheet, load the relevant sheets, build a `string[]` of lines, send via the existing `replyChunked`. The only data-layer change is exposing the visitor `вік` column (already declared in `config.age`, never read) and adding one team filter to `checkin.ts`.

**Tech Stack:** TypeScript, grammY, Google Sheets API v4, Vercel serverless.

**Spec:** `docs/superpowers/specs/2026-08-01-leader-team-views-design.md`

## Global Constraints

- **No test framework exists in this repo.** There is no `npm test`. Every task verifies with `npm run typecheck` plus a manual check through `npm run dev` (long-polling dev server against a scratch bot + scratch spreadsheet — never the live camp data). Do not add Jest/Vitest as part of this work.
- **All user-facing strings live in `src/messages.ts`** in the `M` object. Never inline a Ukrainian string in `src/bot.ts`.
- **All button labels live in `src/keyboards.ts`** in the `BTN` object.
- **Copy is Ukrainian.** Gender-neutral: use `без реєстрації`, never `ще не обрав` / `ще не обрала`.
- **`bot.hears()` registrations must appear before `bot.on("message:text")`** (`src/bot.ts:988`), otherwise button text falls through to visitor name search.
- **No global `bot.catch`** — an uncaught throw becomes an HTTP 500 that Telegram retries as the same update. Both handlers are read-only, so a retry is harmless; do not add try/catch to swallow errors.
- **Sort Ukrainian names with `localeCompare(b, "uk")`**, never a bare `<`/`>` comparison.
- **Team matching is case-insensitive on a trimmed string** — mirror the existing pattern at `src/bot.ts:754`.
- **Commit after each task.**

---

### Task 1: Expose visitor age and add the team filter

**Files:**
- Modify: `src/checkin.ts:4-13` (the `Visitor` interface), `src/checkin.ts:15-26` (the `VisitorSheet` interface), `src/checkin.ts:33-41` (`cols` in `loadVisitors`), `src/checkin.ts:54-63` (the visitor push), and append `visitorsByTeam` after `findByTelegramId` (`src/checkin.ts:106`)
- Test: none (no test framework — see Global Constraints)

**Interfaces:**
- Consumes: `config.age` (`src/config.ts:34`, value `'вік'`), `headerIndex(headerRow, header)` from `src/sheets.ts:71` — trims and lowercases both sides, returns `-1` when not found.
- Produces:
  - `Visitor.age: string` — raw trimmed cell text, `""` when the column or cell is missing
  - `visitorsByTeam(visitors: Visitor[], team: string): Visitor[]` — members of one team, sorted by name

- [ ] **Step 1: Add `age` to the `Visitor` interface**

In `src/checkin.ts`, add the field after `name`:

```ts
export interface Visitor {
  rowIndex: number; // 0-based, including header row
  name: string;
  age: string;
  paymentStatus: string;
  doctorStatus: string;
  team: string;
  room: string;
  telegramId: string;
  checkedIn: string;
}
```

- [ ] **Step 2: Add `age` to the `VisitorSheet` cols type**

```ts
interface VisitorSheet {
  visitors: Visitor[];
  cols: { 
    name: number;
    age: number;
    paymentStatus: number;
    doctorStatus: number;
    checkin: number;
    telegramId: number;
    team: number;
    room: number
  };
}
```

- [ ] **Step 3: Resolve the age column in `loadVisitors`**

Add one line to the `cols` object, after `name`:

```ts
    age:           headerIndex(header, config.age),
```

Do **not** add a guard that throws when `age === -1`. The name/checkin/telegramId guards below it stay as they are; a missing `вік` column must degrade to blank, not break check-in.

- [ ] **Step 4: Map the age cell when building visitors**

Add one line to the `visitors.push({...})` call, after `name`:

```ts
      age: cols.age >= 0 ? (row[cols.age] ?? "").trim() : "",
```

- [ ] **Step 5: Add `visitorsByTeam`**

Append after `findByTelegramId` (around `src/checkin.ts:106`):

```ts
/** Members of one team, sorted by name. Team values are compared trimmed and
 *  case-insensitively — same match as /notifyteam. */
export function visitorsByTeam(visitors: Visitor[], team: string): Visitor[] {
  const target = team.trim().toLowerCase();
  return visitors
    .filter((v) => v.team.trim().toLowerCase() === target)
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exits 0 with no output. If it reports `Property 'age' is missing in type` anywhere, a second object literal builds a `Visitor` and also needs the field — add it there.

- [ ] **Step 7: Commit**

```bash
git add src/checkin.ts
git commit -m "feat(checkin): expose visitor age and add visitorsByTeam"
```

---

### Task 2: Team roster button

**Files:**
- Modify: `src/keyboards.ts:3-11` (`BTN`), `src/keyboards.ts:21-23` (leader branch)
- Modify: `src/messages.ts` — add a `pluralUk` helper above `export const M` and a "Leader team views" block after the `renameTeamHint` line (`src/messages.ts:179`)
- Modify: `src/bot.ts:6-15` (checkin imports), and add handlers near the leader tools; register `bot.hears` at `src/bot.ts:980`
- Test: none (manual — see Step 6)

**Interfaces:**
- Consumes: `visitorsByTeam(visitors, team)` and `Visitor.age` from Task 1; `loadLeaders()` / `findLeadersByTelegramId(leaders, id)` from `src/leaders.ts`; `replyChunked(ctx, lines)` from `src/bot.ts:663`; `M.notLeader` (`src/messages.ts:166`).
- Produces:
  - `BTN.teamRoster` and `BTN.teamMc` (both button labels are added now; `BTN.teamMc` is wired to a handler in Task 3)
  - `myLedTeams(telegramId: number): Promise<string[] | null>` in `src/bot.ts` — distinct team values in `Leaders` sheet order, `null` when the caller leads no team. Task 3 reuses it.
  - `M.teamEmpty` — reused by Task 3.

- [ ] **Step 1: Add both button labels**

In `src/keyboards.ts`, extend `BTN`:

```ts
export const BTN = {
  masterclasses: "🎨 Майстер-класи",
  schedule: "🗓 Розклад",
  myRegs: "📋 Мої реєстрації",
  teamRoster: "👥 Моя команда",
  teamMc: "🎨 МК команди",
  notifyTeam: "📢 Сповістити команду",
  renameTeam: "✏️ Перейменувати команду",
  mcAttendees: "👥 Учасники МК",
  mcNotify: "📣 Сповістити учасників МК",
} as const;
```

- [ ] **Step 2: Emit the new row in the leader branch**

Replace the `opts.leader` branch so the two view buttons share one row above the existing actions:

```ts
  if (opts.leader) {
    kb.row().text(BTN.teamRoster).text(BTN.teamMc);
    kb.row().text(BTN.notifyTeam).row().text(BTN.renameTeam);
  }
```

- [ ] **Step 3: Add the message strings**

In `src/messages.ts`, add this helper above `export const M = {` (after the `GENERAL_INFO` block):

```ts
/** Ukrainian count agreement: 1 учасник / 2-4 учасники / 5+ учасників. */
function pluralUk(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
```

Then add this block inside `M`, right after the `renameTeamHint` line:

```ts
  // Leader team views
  teamRosterHeader: (team: string, count: number) =>
    `👥 Команда ${team} — ${count} ${pluralUk(count, "учасник", "учасники", "учасників")}`,
  teamRosterLine: (n: number, name: string, age: string) =>
    `${n}. ${name}${age ? ` — ${age} р.` : ""}`,
  teamEmpty: "У команді немає учасників.",
  teamMcHeader: (team: string) => `🎨 Команда ${team} — МК сьогодні`,
  teamMcLine: (name: string, mc: string) => `• ${name} — ${mc}`,
  teamMcNone: "без реєстрації",
```

- [ ] **Step 4: Add the handler**

In `src/bot.ts`, extend the `./checkin` import (line 6-15) with `visitorsByTeam`, keeping the list alphabetical:

```ts
import {
  findByTelegramId,
  linkAndCheckIn,
  loadVisitors,
  renameTeamVideo,
  renameVisitorTeams,
  searchByName,
  updateTeamVideo,
  videoForTeam,
  visitorsByTeam,
} from "./checkin";
```

Then add both functions immediately after the `renameteam` callback handler ends (`src/bot.ts:815`), under a `// --- leader team views ---` comment:

```ts
// --- leader team views ---

/** Distinct teams the caller leads, in Leaders-sheet order.
 *  Returns null if the caller is not a leader. */
async function myLedTeams(telegramId: number): Promise<string[] | null> {
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, telegramId);
  if (mine.length === 0) return null;
  return [...new Set(mine.map((l) => l.team))];
}

async function handleTeamRoster(ctx: Context) {
  const teams = await myLedTeams(ctx.from!.id);
  if (!teams) return ctx.reply(M.notLeader);
  const { visitors } = await loadVisitors();
  const lines: string[] = [];
  for (const team of teams) {
    const members = visitorsByTeam(visitors, team);
    lines.push(M.teamRosterHeader(team, members.length), "");
    if (members.length === 0) lines.push(M.teamEmpty);
    members.forEach((v, i) => lines.push(M.teamRosterLine(i + 1, v.name, v.age)));
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return replyChunked(ctx, lines);
}
```

- [ ] **Step 5: Register the button**

In `src/bot.ts`, add one line to the `bot.hears` block so it sits between `myRegs` and `notifyTeam`, matching keyboard order:

```ts
bot.hears(BTN.masterclasses, handleMasterclasses);
bot.hears(BTN.schedule, handleSchedule);
bot.hears(BTN.myRegs, handleMyRegs);
bot.hears(BTN.teamRoster, handleTeamRoster);
bot.hears(BTN.notifyTeam, (ctx) => ctx.reply(M.notifyTeamHint));
```

Leave `BTN.teamMc` unregistered for now — Task 3 wires it. Pressing it in this task falls through to name search; that is expected and is fixed by the next task.

- [ ] **Step 6: Typecheck and verify manually**

Run: `npm run typecheck`
Expected: exits 0.

Then run `npm run dev` (scratch bot + scratch spreadsheet) and check, as a linked leader:

1. `/start` → the keyboard shows `👥 Моя команда` and `🎨 МК команди` on one row above `📢 Сповістити команду`.
2. Press `👥 Моя команда` → header reads `👥 Команда <N> — 7 учасників`, members numbered and alphabetical, ages as `— 13 р.`.
3. Blank a member's `вік` cell in the scratch sheet, press again → that line is name only, no dash.
4. As a non-leader, send the literal text `👥 Моя команда` → reply is `Ця команда доступна лише лідерам команд.`, not a name-search result.
5. Add a second `Leaders` row for the same Telegram ID with a different team → two sections in one reply.
6. Point a leader at a team with no members → header with count `0`, then `У команді немає учасників.`

- [ ] **Step 7: Commit**

```bash
git add src/keyboards.ts src/messages.ts src/bot.ts
git commit -m "feat(leaders): add team roster button"
```

---

### Task 3: Team masterclass view button

**Files:**
- Modify: `src/bot.ts` — add `handleTeamMc` after `handleTeamRoster`; register `bot.hears(BTN.teamMc, …)` after the `BTN.teamRoster` line
- Test: none (manual — see Step 4)

**Interfaces:**
- Consumes: `myLedTeams`, `M.teamMcHeader`, `M.teamMcLine`, `M.teamMcNone`, `M.teamEmpty` from Task 2; `visitorsByTeam` from Task 1; `M.noMasterclassesToday` (`src/messages.ts:46`). From `./masterclasses`, all already imported at `src/bot.ts:16-30`: `loadMCTabRows()`, `loadMCSchedule(prefetched?)`, `loadMasterclasses(prefetched?)`, `todaySlots(schedule)`, `loadMCRegistrations()`. An `MCRegistration` has `{ date, slot, mcId, telegramId, name, cancelled }`; a `Masterclass` has `{ id, title, responsible, place, capacity }`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the handler**

Append after `handleTeamRoster` in `src/bot.ts`:

```ts
async function handleTeamMc(ctx: Context) {
  const teams = await myLedTeams(ctx.from!.id);
  if (!teams) return ctx.reply(M.notLeader);
  const tabRows = await loadMCTabRows();
  const slots = todaySlots(await loadMCSchedule(tabRows));
  if (slots.length === 0) return ctx.reply(M.noMasterclassesToday);
  const mcs = await loadMasterclasses(tabRows);
  const regs = await loadMCRegistrations();
  const { visitors } = await loadVisitors();

  const lines: string[] = [];
  for (const team of teams) {
    const members = visitorsByTeam(visitors, team);
    lines.push(M.teamMcHeader(team), "");
    if (members.length === 0) {
      lines.push(M.teamEmpty, "");
      continue;
    }
    for (const s of slots) {
      lines.push(s.slot);
      for (const v of members) {
        const reg = v.telegramId
          ? regs.find(
              (r) =>
                r.date === s.date &&
                r.slot === s.slot &&
                r.telegramId === v.telegramId &&
                !r.cancelled,
            )
          : undefined;
        // An unknown MC ID (catalog row deleted) reads as "без реєстрації"
        // rather than leaking a bare numeric ID to the leader.
        const title = reg ? mcs.find((m) => m.id === reg.mcId)?.title : undefined;
        lines.push(M.teamMcLine(v.name, title ?? M.teamMcNone));
      }
      lines.push("");
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return replyChunked(ctx, lines);
}
```

`loadMCTabRows()` is fetched once and passed to both `loadMCSchedule` and `loadMasterclasses` — that is the established pattern (`src/bot.ts:832-834`); do not call them without the prefetched rows.

- [ ] **Step 2: Register the button**

```ts
bot.hears(BTN.teamRoster, handleTeamRoster);
bot.hears(BTN.teamMc, handleTeamMc);
bot.hears(BTN.notifyTeam, (ctx) => ctx.reply(M.notifyTeamHint));
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Verify manually**

With `npm run dev`, a scratch spreadsheet whose `MCSchedule` has at least two slots dated today, and at least one team member registered and one not:

1. Press `🎨 МК команди` → `🎨 Команда <N> — МК сьогодні`, then one block per slot, each listing **every** member with either an MC title or `без реєстрації`.
2. Members are alphabetical inside each slot, same order as the roster.
3. A member with an empty `Telegram ID` cell reads `без реєстрації` in every slot.
4. Cancel a registration (fill `Cancelled at` in `EventRegs`) → that member flips to `без реєстрації`.
5. Change every `MCSchedule` date away from today → reply is `Сьогодні майстер-класів немає.`
6. As a non-leader, send the literal text `🎨 МК команди` → `Ця команда доступна лише лідерам команд.`

- [ ] **Step 5: Commit**

```bash
git add src/bot.ts
git commit -m "feat(leaders): add team masterclass view button"
```

---

### Task 4: Help text and documentation

**Files:**
- Modify: `src/messages.ts:76-79` (`capabilitiesLeader`)
- Modify: `CLAUDE.md` — the reply-keyboards table and the role-system Leader line
- Test: none (manual — see Step 3)

**Interfaces:**
- Consumes: the button labels from Task 2.
- Produces: nothing.

- [ ] **Step 1: List the new buttons in the leader capabilities text**

`capabilitiesLeader` is shown after check-in and by `/help` via `roleCapabilitiesText()`. Replace it with:

```ts
  capabilitiesLeader:
    "👑 Як лідер команди:\n" +
    "👥 Моя команда — список учасників вашої команди\n" +
    "🎨 МК команди — на які МК записана ваша команда сьогодні\n" +
    "📢 Сповістити команду — надіслати повідомлення своїй команді\n" +
    "✏️ Перейменувати команду — змінити назву команди",
```

- [ ] **Step 2: Update `CLAUDE.md`**

In the "Reply keyboards" table, replace the Leader row:

```markdown
| Leader | Visitor buttons + `👥 Моя команда` · `🎨 МК команди` · `📢 Сповістити команду` · `✏️ Перейменувати команду` |
```

In the "Role system" section, extend the Leader bullet to read:

```markdown
3. **Leader** — rows in the `Leaders` sheet. Can view their team roster (name + age) and their team's masterclass registrations for today, notify team, rename team, set team video.
```

In "Key design notes", add:

```markdown
- **Leader team views are read-only and button-only** — `👥 Моя команда` and `🎨 МК команди` have no slash-command equivalent and no command-menu entry, because neither takes an argument. The team↔visitor join is `Leaders.Team` against the visitor's `Номер команди` cell (trimmed, case-insensitive); the member↔registration join is `EventRegs.Telegram ID`, so a member who never checked in always reads `без реєстрації`.
```

- [ ] **Step 3: Typecheck and verify**

Run: `npm run typecheck`
Expected: exits 0.

With `npm run dev`, send `/help` as a linked leader — the capability list names all four leader buttons in keyboard order.

- [ ] **Step 4: Commit**

```bash
git add src/messages.ts CLAUDE.md
git commit -m "docs: document leader team views"
```

---

## Deferred / not in scope

Listed so a reviewer does not flag them as omissions — each was explicitly cut during design:

- Payment status, doctor status, room, check-in status on the roster.
- Masterclass registrations for days other than today.
- Slash commands or command-menu entries for either view.
- Caching of sheet reads (the MC view costs 4 Sheets reads per press).
- The `config.paymentStatusHeader` / `Оплата` column mismatch noticed during estimation — unrelated to these views.
