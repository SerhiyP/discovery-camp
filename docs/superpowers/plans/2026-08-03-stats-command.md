# `/stats` Admin Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only `/stats` command that reports total visitors vs checked-in
count, and active masterclass registrations grouped by day/slot.

**Architecture:** Pure aggregation over two existing Mongo reads (`getVisitorsMongo()`,
`getRegistrations()`), formatted into message lines and sent via the existing
`replyChunked` helper. No new collections, no new sync logic, no new files.

**Tech Stack:** TypeScript, grammY, MongoDB driver (via `src/mc-store.ts` /
`src/visitor-store.ts`), same stack as the rest of `src/bot.ts`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-03-stats-command-design.md`.
- Admin-gated via `isAdmin(ctx.from?.id, admins)` (`src/admins.ts`) — same gate as
  `/syncmc`/`/syncvisitors`/`/syncschedule`.
- Typed command only (`/stats`) — do not add to `ADMIN_COMMANDS` in `src/commands.ts`.
- All user-facing strings live in the `M` object in `src/messages.ts` — no inline
  Ukrainian strings in `src/bot.ts`.
- This repo has no test suite (see root `CLAUDE.md`). Verification is
  `npm run typecheck` plus manual exercise via `npm run dev` (local long-polling
  dev server against a scratch bot token/spreadsheet — never the live camp data).
- Own try/catch per command, not `mongoGuarded` (that wrapper is for user-facing
  handlers; admin sync/report commands report failure via a dedicated `syncFailed`-style
  message instead), matching `/syncmc`/`/syncvisitors`/`/syncschedule`.

---

### Task 1: Add `/stats` message strings

**Files:**
- Modify: `src/messages.ts:188` (insert new entries directly after the `syncFailed` line)

**Interfaces:**
- Produces: `M.statsFailed: string`, `M.statsTitle: string`,
  `M.statsVisitors(total: number): string`,
  `M.statsCheckedIn(checkedIn: number, pct: number): string`,
  `M.statsRegsTitle: string`, `M.statsSlotLine(slot: string, count: number): string`,
  `M.statsRegsTotal(total: number): string` — all consumed by Task 2.

- [ ] **Step 1: Add the message entries**

Open `src/messages.ts` and insert immediately after line 188
(`syncFailed: "Не вдалося синхронізувати. Спробуйте ще раз за хвилину.",`):

```ts
  statsFailed: "Не вдалося зібрати статистику. Спробуйте ще раз за хвилину.",
  statsTitle: "📊 Статистика табору",
  statsVisitors: (total: number) => `Відвідувачів: ${total}`,
  statsCheckedIn: (checkedIn: number, pct: number) => `Заселено: ${checkedIn} (${pct}%)`,
  statsRegsTitle: "Реєстрації на МК:",
  statsSlotLine: (slot: string, count: number) => `  ${slot}: ${count}`,
  statsRegsTotal: (total: number) => `Всього реєстрацій: ${total}`,
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes with no errors (this step only adds object literal entries, no
consumers yet, so nothing can fail beyond a syntax typo).

- [ ] **Step 3: Commit**

```bash
git add src/messages.ts
git commit -m "feat(stats): add /stats message strings"
```

---

### Task 2: Add `/stats` aggregation and command handler

**Files:**
- Modify: `src/bot.ts` — add type imports (near existing `./checkin` and `./mc-store`
  imports), add a `formatStats` helper (near `replyChunked`, `src/bot.ts:829-843`), add
  `bot.command("stats", ...)` (after the `syncschedule` command block, `src/bot.ts:896-905`,
  before the `// --- superadmin commands ---` comment on `src/bot.ts:907`).

**Interfaces:**
- Consumes: `M.statsFailed`, `M.statsTitle`, `M.statsVisitors`, `M.statsCheckedIn`,
  `M.statsRegsTitle`, `M.statsSlotLine`, `M.statsRegsTotal` (Task 1);
  `getVisitorsMongo(): Promise<Visitor[]>` (`src/visitor-store.ts:63`, already imported
  in `src/bot.ts:60`); `getRegistrations(): Promise<MongoRegistration[]>`
  (`src/mc-store.ts:113`, already imported in `src/bot.ts:52`); `Visitor` interface
  (`src/checkin.ts:4`, fields used: `checkedIn: string`); `MongoRegistration` interface
  (`src/mc-store.ts:65`, fields used: `date: string`, `slot: string`, `active: boolean`);
  `isAdmin`, `loadAdmins` (`src/admins.ts`, already imported); `replyChunked`
  (`src/bot.ts:829`, already defined in this file).
- Produces: `formatStats(visitors: Visitor[], regs: MongoRegistration[]): string[]` —
  not consumed outside this task, but kept as a named function (not inlined in the
  handler) so it stays independently readable/testable if a test suite is added later.

- [ ] **Step 1: Add type-only imports**

`Visitor` and `MongoRegistration` are currently imported into `src/bot.ts` only as
value-level function imports from their respective modules; the types themselves
aren't imported. Update the two existing import blocks:

In `src/bot.ts:5-13`, change:

```ts
import {
  isMeaningfulNeed,
  loadVisitors,
  renameTeamVideo,
  searchByName,
  updateTeamVideo,
  videoForTeam,
  visitorsByTeam,
} from "./checkin";
```

to:

```ts
import {
  isMeaningfulNeed,
  loadVisitors,
  renameTeamVideo,
  searchByName,
  updateTeamVideo,
  Visitor,
  videoForTeam,
  visitorsByTeam,
} from "./checkin";
```

In `src/bot.ts:46-57`, change:

```ts
import {
  asMCRegistrations,
  ensureIndexes,
  getMasterclasses,
  getMCSchedule,
  getMCTopics,
  getRegistrations,
  registerMongo,
  syncCampSchedule,
  syncMCFromSheets,
  unregisterMongo,
} from "./mc-store";
```

to:

```ts
import {
  asMCRegistrations,
  ensureIndexes,
  getMasterclasses,
  getMCSchedule,
  getMCTopics,
  getRegistrations,
  MongoRegistration,
  registerMongo,
  syncCampSchedule,
  syncMCFromSheets,
  unregisterMongo,
} from "./mc-store";
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes (`tsconfig.json` does not set `noUnusedLocals`, so the as-yet-unused
`Visitor`/`MongoRegistration` type imports don't error).

- [ ] **Step 3: Add the `formatStats` helper**

Insert directly after the `replyChunked` function (`src/bot.ts:829-843`, i.e. after the
closing `}` on line 843):

```ts
function formatStats(visitors: Visitor[], regs: MongoRegistration[]): string[] {
  const total = visitors.length;
  const checkedIn = visitors.filter((v) => v.checkedIn !== "").length;
  const pct = total > 0 ? Math.round((checkedIn / total) * 100) : 0;

  const active = regs.filter((r) => r.active);
  const byDate = new Map<string, Map<string, number>>();
  for (const r of active) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    const slots = byDate.get(r.date)!;
    slots.set(r.slot, (slots.get(r.slot) ?? 0) + 1);
  }
  const dates = [...byDate.keys()].sort();

  const lines = [
    M.statsTitle,
    "",
    M.statsVisitors(total),
    M.statsCheckedIn(checkedIn, pct),
    "",
    M.statsRegsTitle,
  ];
  for (const date of dates) {
    lines.push(date);
    for (const [slot, count] of byDate.get(date)!) {
      lines.push(M.statsSlotLine(slot, count));
    }
  }
  lines.push("", M.statsRegsTotal(active.length));
  return lines;
}
```

- [ ] **Step 4: Add the `/stats` command handler**

Insert after the `syncschedule` command block (`src/bot.ts:896-905`), immediately
before the `// --- superadmin commands ---` comment (`src/bot.ts:907`):

```ts
bot.command("stats", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  try {
    const [visitors, regs] = await Promise.all([getVisitorsMongo(), getRegistrations()]);
    return replyChunked(ctx, formatStats(visitors, regs));
  } catch (err) {
    console.error("stats failed", err);
    return ctx.reply(M.statsFailed);
  }
});
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: passes with no errors.

- [ ] **Step 6: Manual verification via the dev server**

Per root `CLAUDE.md`, this repo has no automated tests — verify by running the bot
against a scratch bot token and scratch spreadsheet/Mongo (never the live camp data):

```bash
npm run dev
```

In Telegram, as an account listed in `ADMIN_IDS` (or the `Admins` sheet) for the
scratch environment, send `/stats` to the bot. Confirm:
- The reply arrives (not an error message).
- "Відвідувачів" matches the scratch Visitors mirror's document count (check via
  `getVisitorsMongo()` count, or the `visitors` collection count directly).
- "Заселено" matches the count of visitor docs with a non-empty `checkedIn`.
- Each listed day's slot counts match the count of `active: true` documents in the
  `registrations` collection for that `(date, slot)`.
- "Всього реєстрацій" equals the sum of all slot counts shown.
- Days/slots with zero active registrations are absent (not shown as `0`).

Then, as a non-admin account, send `/stats` and confirm it replies with
`M.notAdmin` ("Ця команда доступна лише адміністраторам.") instead of running.

- [ ] **Step 7: Commit**

```bash
git add src/bot.ts
git commit -m "feat(stats): add /stats admin command"
```

---

## Self-Review Notes

- **Spec coverage:** access control (Task 2 Step 4), data sources (Task 2 Steps 1, 3),
  output format (Task 2 Step 3 — matches the spec's example layout line-for-line),
  error handling (Task 2 Step 4's catch block + `M.statsFailed` from Task 1), no
  menu entry (explicitly called out in Global Constraints, no task adds one) are all
  covered. Out-of-scope items from the spec (per-MC breakdown, per-team breakdown,
  historical tracking) have no corresponding task, as intended.
- **Type consistency:** `formatStats(visitors: Visitor[], regs: MongoRegistration[])`
  in Task 2 Step 3 matches the call site in Step 4 (`formatStats(visitors, regs)` where
  `visitors`/`regs` come from the `Promise.all` destructure of
  `getVisitorsMongo()`/`getRegistrations()`), and matches the "Produces" line in the
  Task 2 header.
