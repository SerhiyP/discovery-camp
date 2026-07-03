# Masterclasses Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic Events feature with a masterclass system: catalog + per-day/per-slot schedule in Google Sheets, one-registration-per-slot rule, and a new "responsible person" role that can view and message attendees.

**Architecture:** New `src/masterclasses.ts` (catalog/schedule/registration logic, replaces `src/events.ts`) and `src/responsible.ts` (role CRUD + linking, mirrors `src/leaders.ts`). `src/bot.ts` handlers are rewritten for the slot-based flow; reply keyboards become role-composed. Registrations stay in the `EventRegs` tab with a new schema `Date | Slot | MC ID | Telegram ID | Name | Registered at | Cancelled at`.

**Tech Stack:** TypeScript, grammY, googleapis (Google Sheets v4), Vercel serverless.

**Spec:** `docs/superpowers/specs/2026-07-03-masterclasses-design.md`

## Global Constraints

- No test framework and no local dev server: every task is verified with `npm run typecheck` (must pass clean) plus diff inspection. Runtime behavior is confirmed after deploy (`npx vercel --prod` + `npm run set-webhook`), out of scope here.
- All user-facing strings are Ukrainian and live only in the `M` object in `src/messages.ts`.
- Sheet row indices are 0-based including the header row; A1 addresses add 1 (see `src/sheets.ts`).
- The bot is serverless — **no in-memory state between updates**. Multi-step flows must round-trip state through message text or callback data (see the existing `renameteam` flow, `src/bot.ts:421-445`).
- Capacity `0` or blank = unlimited. Cancellation is a soft delete (timestamp in `Cancelled at`).
- The known capacity race window (no transactions) is accepted — do not add locking.
- Callback data must stay under Telegram's 64-byte limit (all formats below fit).

---

### Task 1: `src/masterclasses.ts` — catalog, schedule, registrations

**Files:**
- Modify: `src/config.ts:29-33` (tab names)
- Create: `src/masterclasses.ts`

**Interfaces:**
- Consumes: `getRows`, `getRowsFromSpreadsheet`, `appendRow`, `updateCell`, `headerIndex` from `./sheets`; `config`, `todayISO`, `nowStamp` from `./config`.
- Produces (used by Tasks 4–6):
  - `interface Masterclass { id: string; title: string; responsible: string; place: string; capacity: number }`
  - `interface SlotSchedule { date: string; slot: string; mcIds: string[] }`
  - `interface MCRegistration { rowIndex: number; date: string; slot: string; mcId: string; telegramId: string; name: string; cancelled: boolean }`
  - `loadMasterclasses(): Promise<Masterclass[]>`
  - `loadMCSchedule(): Promise<SlotSchedule[]>`
  - `loadMCRegistrations(): Promise<MCRegistration[]>`
  - `todaySlots(schedule: SlotSchedule[]): SlotSchedule[]`
  - `activeRegs(regs: MCRegistration[], date: string, slot: string, mcId: string): MCRegistration[]`
  - `type RegisterResult = "ok" | "full" | "already" | "slot_taken"`
  - `register(date: string, slot: string, mcId: string, capacity: number, telegramId: number, name: string): Promise<RegisterResult>`
  - `unregister(date: string, slot: string, mcId: string, telegramId: number): Promise<boolean>`

- [ ] **Step 1: Add tab name to config**

In `src/config.ts`, replace lines 29-33:

```ts
  eventsTab: "Events",
  registrationsTab: "EventRegs",
  adminsTab: "Admins",
  leadersTab: "Leaders",
  videosTab: "Videos",
```

with:

```ts
  eventsTab: "Events",
  registrationsTab: "EventRegs",
  mcScheduleTab: "MCSchedule",
  adminsTab: "Admins",
  leadersTab: "Leaders",
  videosTab: "Videos",
```

(`eventsTab` is removed later in Task 4 together with `src/events.ts`. The masterclass
**catalog** tab is not configured here — it lives in the read-only grid spreadsheet and
its name is a module constant, like `GRID_TAB` in `src/schedule.ts`.)

- [ ] **Step 2: Create `src/masterclasses.ts`**

Create the file with this exact content:

```ts
import { config, nowStamp, todayISO } from "./config";
import {
  appendRow,
  getRows,
  getRowsFromSpreadsheet,
  headerIndex,
  updateCell,
} from "./sheets";

// The catalog lives in the read-only grid spreadsheet (GRID_SHEET_ID), maintained by
// the organizers. Layout: a banner row, then a header row ("№ | Назва | …"), then the
// catalog rows; tournament tables follow below and must be ignored.
const MC_CATALOG_TAB = "5.Майстер-класи 2026";

export interface Masterclass {
  id: string;
  title: string;
  responsible: string; // display text only; linking lives in MCResponsible
  place: string;
  capacity: number; // 0 = unlimited
}

export interface SlotSchedule {
  date: string; // YYYY-MM-DD
  slot: string; // shown verbatim, e.g. "12:00-13:00"; part of the registration key
  mcIds: string[];
}

export interface MCRegistration {
  rowIndex: number;
  date: string;
  slot: string;
  mcId: string;
  telegramId: string;
  name: string;
  cancelled: boolean;
}

export async function loadMasterclasses(): Promise<Masterclass[]> {
  if (!config.gridSheetId) return [];
  const rows = await getRowsFromSpreadsheet(config.gridSheetId, MC_CATALOG_TAB);
  // The header row is not the first row — find the row that contains "Назва".
  const headerRowIdx = rows.findIndex((r) => headerIndex(r, "Назва") !== -1);
  if (headerRowIdx === -1) return [];
  const h = rows[headerRowIdx];
  const c = {
    id: headerIndex(h, "№"),
    title: headerIndex(h, "Назва"),
    responsible: headerIndex(h, "Відповідальний"),
    place: headerIndex(h, "Місце проведення"),
    capacity: headerIndex(h, "Кількість учасників"),
  };
  const mcs: Masterclass[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    // "№" values look like "1." — canonical ID is "1". Rows without a numeric "№"
    // (blank separators, tournament tables below the catalog) are skipped.
    const idMatch = (row[c.id] ?? "").trim().match(/^(\d+)\.?$/);
    const title = (row[c.title] ?? "").trim();
    if (!idMatch || !title) continue;
    const capRaw = (row[c.capacity] ?? "").trim().toLowerCase();
    mcs.push({
      id: idMatch[1],
      title,
      responsible: (row[c.responsible] ?? "").trim(),
      place: (row[c.place] ?? "").trim(),
      capacity: capRaw === "без обмежень" ? 0 : Number(capRaw) || 0,
    });
  }
  return mcs;
}

export async function loadMCSchedule(): Promise<SlotSchedule[]> {
  const rows = await getRows(config.mcScheduleTab);
  if (rows.length === 0) return [];
  const h = rows[0];
  const c = {
    date: headerIndex(h, "Date"),
    slot: headerIndex(h, "Slot"),
    mcIds: headerIndex(h, "MC IDs"),
  };
  const slots: SlotSchedule[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const date = (row[c.date] ?? "").trim();
    const slot = (row[c.slot] ?? "").trim();
    const mcIds = (row[c.mcIds] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!date || !slot || mcIds.length === 0) continue;
    slots.push({ date, slot, mcIds });
  }
  return slots;
}

export function todaySlots(schedule: SlotSchedule[]): SlotSchedule[] {
  const today = todayISO();
  return schedule.filter((s) => s.date === today);
}

// EventRegs columns: Date | Slot | MC ID | Telegram ID | Name | Registered at | Cancelled at
export async function loadMCRegistrations(): Promise<MCRegistration[]> {
  const rows = await getRows(config.registrationsTab);
  const regs: MCRegistration[] = [];
  for (let i = 1; i < rows.length; i++) {
    const [date, slot, mcId, telegramId, name, , cancelled] = rows[i];
    if (!date || !slot || !mcId || !telegramId) continue;
    regs.push({
      rowIndex: i,
      date: date.trim(),
      slot: slot.trim(),
      mcId: mcId.trim(),
      telegramId: telegramId.trim(),
      name: (name ?? "").trim(),
      cancelled: (cancelled ?? "").trim() !== "",
    });
  }
  return regs;
}

export function activeRegs(
  regs: MCRegistration[],
  date: string,
  slot: string,
  mcId: string,
): MCRegistration[] {
  return regs.filter(
    (r) => r.date === date && r.slot === slot && r.mcId === mcId && !r.cancelled,
  );
}

export type RegisterResult = "ok" | "full" | "already" | "slot_taken";

export async function register(
  date: string,
  slot: string,
  mcId: string,
  capacity: number,
  telegramId: number,
  name: string,
): Promise<RegisterResult> {
  const regs = await loadMCRegistrations();
  const slotMine = regs.find(
    (r) =>
      r.date === date &&
      r.slot === slot &&
      r.telegramId === String(telegramId) &&
      !r.cancelled,
  );
  if (slotMine) return slotMine.mcId === mcId ? "already" : "slot_taken";
  const active = activeRegs(regs, date, slot, mcId);
  if (capacity > 0 && active.length >= capacity) return "full";
  await appendRow(config.registrationsTab, [
    date,
    slot,
    mcId,
    String(telegramId),
    name,
    nowStamp(),
    "",
  ]);
  return "ok";
}

export async function unregister(
  date: string,
  slot: string,
  mcId: string,
  telegramId: number,
): Promise<boolean> {
  const regs = await loadMCRegistrations();
  const mine = activeRegs(regs, date, slot, mcId).find(
    (r) => r.telegramId === String(telegramId),
  );
  if (!mine) return false;
  // column G = "Cancelled at"
  await updateCell(config.registrationsTab, mine.rowIndex, 6, nowStamp());
  return true;
}
```

- [ ] **Step 3: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors (nothing imports the new module yet).

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/masterclasses.ts
git commit -m "feat: add masterclasses module (catalog, schedule, registrations)"
```

---

### Task 2: `src/responsible.ts` — responsible-person role

**Files:**
- Modify: `src/config.ts` (add `responsibleTab`)
- Create: `src/responsible.ts`

**Interfaces:**
- Consumes: `getRows`, `appendRow`, `clearRow`, `updateCell`, `headerIndex` from `./sheets`; `config`, `nowStamp` from `./config`.
- Produces (used by Tasks 3, 5, 6):
  - `interface Responsible { rowIndex: number; mcId: string; name: string; telegramId: string; addedAt: string }`
  - `interface ResponsibleSheet { responsible: Responsible[]; cols: { mcId: number; name: number; telegramId: number; addedAt: number } }`
  - `loadResponsible(): Promise<ResponsibleSheet>`
  - `findResponsibleByTelegramId(list: Responsible[], telegramId: number): Responsible[]`
  - `searchResponsibleByName(list: Responsible[], query: string): Responsible[]` (unlinked rows only)
  - `linkResponsibleRows(sheet: ResponsibleSheet, name: string, telegramId: number): Promise<Responsible[]>` (links ALL unlinked rows with that normalized name; one person may run several MCs)
  - `addResponsible(mcId: string, name: string): Promise<"ok" | "duplicate">`
  - `removeResponsible(mcId: string, name: string): Promise<boolean>`

- [ ] **Step 1: Add tab name to config**

In `src/config.ts`, after the `mcScheduleTab: "MCSchedule",` line add:

```ts
  responsibleTab: "MCResponsible",
```

- [ ] **Step 2: Create `src/responsible.ts`**

Mirrors `src/leaders.ts` (same normalization and prefix-match search). Create with this exact content:

```ts
import { config, nowStamp } from "./config";
import { appendRow, clearRow, getRows, headerIndex, updateCell } from "./sheets";

export interface Responsible {
  rowIndex: number;
  mcId: string;
  name: string;
  telegramId: string;
  addedAt: string;
}

export interface ResponsibleSheet {
  responsible: Responsible[];
  cols: { mcId: number; name: number; telegramId: number; addedAt: number };
}

// MCResponsible columns: MC ID | Name | Telegram ID | Added at
export async function loadResponsible(): Promise<ResponsibleSheet> {
  const rows = await getRows(config.responsibleTab);
  if (rows.length === 0) {
    return { responsible: [], cols: { mcId: 0, name: 1, telegramId: 2, addedAt: 3 } };
  }
  const header = rows[0];
  const cols = {
    mcId: headerIndex(header, "MC ID"),
    name: headerIndex(header, "Name"),
    telegramId: headerIndex(header, "Telegram ID"),
    addedAt: headerIndex(header, "Added at"),
  };
  const responsible: Responsible[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const mcId = (row[cols.mcId] ?? "").trim();
    const name = (row[cols.name] ?? "").trim();
    if (!mcId && !name) continue; // cleared row
    responsible.push({
      rowIndex: i,
      mcId,
      name,
      telegramId: (row[cols.telegramId] ?? "").trim(),
      addedAt: (row[cols.addedAt] ?? "").trim(),
    });
  }
  return { responsible, cols };
}

export function findResponsibleByTelegramId(
  list: Responsible[],
  telegramId: number,
): Responsible[] {
  return list.filter((r) => r.telegramId === String(telegramId));
}

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[''ʼ`]/g, "").replace(/\s+/g, " ").trim();
}

/** Returns unlinked responsible rows matching the query (same prefix-match logic as leaders). */
export function searchResponsibleByName(list: Responsible[], query: string): Responsible[] {
  const q = normalizeStr(query);
  if (!q) return [];
  const qTokens = q.split(" ");
  return list
    .filter((r) => !r.telegramId)
    .filter((r) => {
      const nTokens = normalizeStr(r.name).split(" ");
      return qTokens.every((qt) => nTokens.some((nt) => nt.startsWith(qt)));
    });
}

/** Links every unlinked row with the same normalized name (one person may run several MCs). */
export async function linkResponsibleRows(
  sheet: ResponsibleSheet,
  name: string,
  telegramId: number,
): Promise<Responsible[]> {
  const target = normalizeStr(name);
  const rows = sheet.responsible.filter(
    (r) => !r.telegramId && normalizeStr(r.name) === target,
  );
  for (const r of rows) {
    await updateCell(config.responsibleTab, r.rowIndex, sheet.cols.telegramId, String(telegramId));
  }
  return rows;
}

export async function addResponsible(
  mcId: string,
  name: string,
): Promise<"ok" | "duplicate"> {
  const { responsible } = await loadResponsible();
  if (
    responsible.some(
      (r) => r.mcId === mcId && normalizeStr(r.name) === normalizeStr(name),
    )
  ) {
    return "duplicate";
  }
  await appendRow(config.responsibleTab, [mcId, name, "", nowStamp()]);
  return "ok";
}

export async function removeResponsible(mcId: string, name: string): Promise<boolean> {
  const { responsible } = await loadResponsible();
  const row = responsible.find(
    (r) => r.mcId === mcId && normalizeStr(r.name) === normalizeStr(name),
  );
  if (!row) return false;
  await clearRow(config.responsibleTab, row.rowIndex);
  return true;
}
```

- [ ] **Step 3: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/responsible.ts
git commit -m "feat: add responsible-person module for masterclasses"
```

---

### Task 3: Role-composed keyboards

**Files:**
- Modify: `src/keyboards.ts` (full rewrite)
- Modify: `src/bot.ts:35` (keyboards import), `src/bot.ts:41-48` (`keyboardForUser`), `src/bot.ts:133` (`link_leader` reply), `src/bot.ts:449-453` (`bot.hears` lines)

**Interfaces:**
- Consumes: `loadResponsible`, `findResponsibleByTelegramId` from `./responsible` (Task 2).
- Produces (used by Tasks 4–6):
  - `BTN.masterclasses = "🎨 Майстер-класи"`, `BTN.myRegs = "📋 Мої реєстрації"`, `BTN.mcAttendees = "👥 Учасники МК"`, `BTN.mcNotify = "📣 Сповістити учасників МК"` (plus unchanged `BTN.schedule`, `BTN.notifyTeam`, `BTN.renameTeam`)
  - `roleKeyboard(opts?: { leader?: boolean; responsible?: boolean }): Keyboard` — replaces `visitorKeyboard()` / `leaderKeyboard()`

- [ ] **Step 1: Rewrite `src/keyboards.ts`**

Replace the entire file content with:

```ts
import { Keyboard } from "grammy";

export const BTN = {
  masterclasses: "🎨 Майстер-класи",
  schedule: "🗓 Розклад",
  myRegs: "📋 Мої реєстрації",
  notifyTeam: "📢 Сповістити команду",
  renameTeam: "✏️ Перейменувати команду",
  mcAttendees: "👥 Учасники МК",
  mcNotify: "📣 Сповістити учасників МК",
} as const;

/** Reply keyboard composed from roles: base visitor rows, plus leader and/or
 *  responsible rows — a person can be both leader and responsible. */
export function roleKeyboard(
  opts: { leader?: boolean; responsible?: boolean } = {},
): Keyboard {
  const kb = new Keyboard()
    .text(BTN.masterclasses).text(BTN.schedule).row()
    .text(BTN.myRegs);
  if (opts.leader) {
    kb.row().text(BTN.notifyTeam).row().text(BTN.renameTeam);
  }
  if (opts.responsible) {
    kb.row().text(BTN.mcAttendees).row().text(BTN.mcNotify);
  }
  return kb.resized().persistent();
}
```

- [ ] **Step 2: Update `src/bot.ts` call sites**

Replace line 35:

```ts
import { BTN, leaderKeyboard, visitorKeyboard } from "./keyboards";
```

with:

```ts
import { BTN, roleKeyboard } from "./keyboards";
import { findResponsibleByTelegramId, loadResponsible } from "./responsible";
```

Replace `keyboardForUser` (lines 41-48) with:

```ts
async function keyboardForUser(telegramId: number): Promise<import("grammy").Keyboard | undefined> {
  const [{ leaders }, { responsible }] = await Promise.all([loadLeaders(), loadResponsible()]);
  const isLeader = findLeadersByTelegramId(leaders, telegramId).length > 0;
  const isResponsible = findResponsibleByTelegramId(responsible, telegramId).length > 0;
  if (isLeader || isResponsible) {
    return roleKeyboard({ leader: isLeader, responsible: isResponsible });
  }
  const { visitors } = await loadVisitors();
  if (findByTelegramId(visitors, telegramId)) return roleKeyboard();
  return undefined;
}
```

In the `link_leader` callback, replace line 133:

```ts
  await ctx.reply(M.leaderCheckedIn(leader.name, leader.team), { reply_markup: leaderKeyboard() });
```

with:

```ts
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.leaderCheckedIn(leader.name, leader.team), kb ? { reply_markup: kb } : {});
```

Update the `bot.hears` lines (449-451) for the renamed BTN keys — handlers stay the old ones until Task 4:

```ts
bot.hears(BTN.masterclasses, handleEvents);
bot.hears(BTN.schedule, handleSchedule);
bot.hears(BTN.myRegs, handleMyEvents);
```

(`bot.hears(BTN.notifyTeam, ...)` and `bot.hears(BTN.renameTeam, ...)` are unchanged.)

- [ ] **Step 3: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors. (`visitorKeyboard`/`leaderKeyboard` have no remaining references.)

- [ ] **Step 4: Commit**

```bash
git add src/keyboards.ts src/bot.ts
git commit -m "feat: role-composed reply keyboard with masterclass buttons"
```

---

### Task 4: Visitor flow — masterclass browsing and registration

**Files:**
- Modify: `src/bot.ts` (imports, events section `136-232`, hears lines)
- Modify: `src/messages.ts` (swap event strings for masterclass strings)
- Modify: `src/commands.ts:12-16` (`USER_COMMANDS`)
- Modify: `src/config.ts` (remove `eventsTab`)
- Delete: `src/events.ts`

**Interfaces:**
- Consumes (Task 1): `loadMasterclasses`, `loadMCSchedule`, `loadMCRegistrations`, `todaySlots`, `activeRegs`, `register`, `unregister`; (Task 3): `BTN.masterclasses`, `BTN.myRegs`.
- Produces (used by Task 6): `handleMasterclasses(ctx)`, `handleMyRegs(ctx)` — bot-internal; message keys `M.noMasterclassesToday`, `M.mcSlotTitle`, `M.mcLine`, `M.mcRegistered`, `M.mcUnregistered`, `M.mcFull`, `M.mcAlready`, `M.mcSlotTaken`, `M.myRegsTitle`, `M.myRegsEmpty`, `M.scheduleUnavailable`.
- Callback data formats: `mcreg:<date>:<slot>:<mcId>` and `mcunreg:<date>:<slot>:<mcId>`. `<slot>` contains colons (`12:00-13:00`), so the parsing regex anchors the fixed-format date and the colon-free mcId: `/^mcreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/`.

- [ ] **Step 1: Update `src/messages.ts`**

Remove these keys (all consumers are rewritten in this task): `noEventsToday`, `eventsToday`, `scheduleTitle`, `registered`, `unregistered`, `eventFull`, `alreadyRegistered`, `myEventsTitle`, `myEventsEmpty`, `morningDigest`, `registerButton`, `unregisterButton`, `spotsLeft`.

In their place (after `videoCaption`) add:

```ts
  noMasterclassesToday: "Сьогодні майстер-класів немає.",
  mcSlotTitle: (slot: string) => `🎨 Майстер-класи ${slot}:`,
  mcLine: (
    mc: { title: string; place: string; capacity: number },
    taken: number,
    mine: boolean,
  ) =>
    `• ${mc.title} (${mc.place})${
      mc.capacity > 0 ? ` — ${taken}/${mc.capacity}` : ""
    }${mine ? " ✅" : ""}`,
  mcRegistered: (title: string, slot: string) =>
    `Ви зареєстровані на «${title}» (${slot}) ✅`,
  mcUnregistered: (title: string, slot: string) =>
    `Реєстрацію на «${title}» (${slot}) скасовано.`,
  mcFull: "На жаль, місць більше немає 😔",
  mcAlready: "Ви вже зареєстровані на цей майстер-клас.",
  mcSlotTaken:
    "У цей час ви вже зареєстровані на інший майстер-клас. Спершу скасуйте ту реєстрацію.",
  myRegsTitle: "Ваші реєстрації:",
  myRegsEmpty: "Ви поки не зареєстровані на жодний майстер-клас.",
  scheduleUnavailable: "Розклад тимчасово недоступний.",
```

(`mustCheckInFirst` stays.)

- [ ] **Step 2: Rewrite the events section of `src/bot.ts`**

Replace the events import block (lines 13-21):

```ts
import {
  activeRegs,
  loadEvents,
  loadRegistrations,
  register,
  todayEvents,
  unregister,
  upcomingEvents,
} from "./events";
```

with:

```ts
import {
  activeRegs,
  loadMasterclasses,
  loadMCRegistrations,
  loadMCSchedule,
  register,
  todaySlots,
  unregister,
} from "./masterclasses";
```

Change the config import (line 2) to:

```ts
import { config, todayISO } from "./config";
```

Replace the whole `// --- events ---` section (the `eventLine` helper, `handleEvents`, `handleSchedule`, `handleMyEvents`, the three `bot.command` lines, and the `reg:`/`unreg:` callbacks — lines 136-232) with:

```ts
// --- masterclasses ---

async function handleMasterclasses(ctx: Context) {
  const [mcs, schedule, regs] = await Promise.all([
    loadMasterclasses(),
    loadMCSchedule(),
    loadMCRegistrations(),
  ]);
  const slots = todaySlots(schedule);
  let sentAny = false;
  for (const s of slots) {
    const kb = new InlineKeyboard();
    const lines: string[] = [M.mcSlotTitle(s.slot), ""];
    let listed = 0;
    for (const id of s.mcIds) {
      const mc = mcs.find((m) => m.id === id);
      if (!mc) continue; // unknown ID in MCSchedule (or empty catalog) — skip silently
      const taken = activeRegs(regs, s.date, s.slot, mc.id);
      const mine = taken.some((r) => r.telegramId === String(ctx.from!.id));
      lines.push(M.mcLine(mc, taken.length, mine));
      kb.text(
        `${mine ? "❌" : "📝"} ${mc.title}`,
        `${mine ? "mcunreg" : "mcreg"}:${s.date}:${s.slot}:${mc.id}`,
      ).row();
      listed++;
    }
    if (listed === 0) continue;
    await ctx.reply(lines.join("\n"), { reply_markup: kb });
    sentAny = true;
  }
  if (!sentAny) return ctx.reply(M.noMasterclassesToday);
}

async function handleSchedule(ctx: Context) {
  const result = await loadTodaySchedule();
  if (result.status === "finished") return ctx.reply(M.scheduleCampFinished);
  if (result.status === "ok") {
    const { schedule } = result;
    const lines: string[] = [];
    if (!schedule.isToday) lines.push(M.scheduleNotStarted, "");
    lines.push(M.scheduleGridTitle(schedule.dayLabel), "");
    lines.push(...schedule.slots.map((s) => M.scheduleGridLine(s)));
    return ctx.reply(lines.join("\n"));
  }
  return ctx.reply(M.scheduleUnavailable);
}

async function handleMyRegs(ctx: Context) {
  const [mcs, regs] = await Promise.all([loadMasterclasses(), loadMCRegistrations()]);
  const today = todayISO();
  const mine = regs.filter(
    (r) => r.telegramId === String(ctx.from!.id) && !r.cancelled && r.date >= today,
  );
  if (mine.length === 0) return ctx.reply(M.myRegsEmpty);
  const lines = [M.myRegsTitle, ""];
  for (const r of mine) {
    const mc = mcs.find((m) => m.id === r.mcId);
    if (mc) lines.push(`• ${r.date}, ${r.slot} — ${mc.title} (${mc.place})`);
  }
  return ctx.reply(lines.join("\n"));
}

bot.command("mc", handleMasterclasses);
bot.command("schedule", handleSchedule);
bot.command("myevents", handleMyRegs);

bot.callbackQuery(/^mcreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  const [mcs, { visitors }] = await Promise.all([loadMasterclasses(), loadVisitors()]);
  const mc = mcs.find((m) => m.id === mcId);
  const me = findByTelegramId(visitors, ctx.from.id);
  if (!mc) return ctx.answerCallbackQuery();
  if (!me) {
    await ctx.answerCallbackQuery();
    return ctx.reply(M.mustCheckInFirst);
  }
  const result = await register(date, slot, mcId, mc.capacity, ctx.from.id, me.name);
  await ctx.answerCallbackQuery(
    result === "ok"
      ? M.mcRegistered(mc.title, slot)
      : result === "full"
        ? M.mcFull
        : result === "already"
          ? M.mcAlready
          : M.mcSlotTaken,
  );
  if (result === "ok") await ctx.reply(M.mcRegistered(mc.title, slot));
  if (result === "slot_taken") await ctx.reply(M.mcSlotTaken);
});

bot.callbackQuery(/^mcunreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  const mcs = await loadMasterclasses();
  const mc = mcs.find((m) => m.id === mcId);
  const ok = await unregister(date, slot, mcId, ctx.from.id);
  await ctx.answerCallbackQuery();
  if (ok && mc) await ctx.reply(M.mcUnregistered(mc.title, slot));
});
```

Update the two `bot.hears` handler references (near the bottom of the file):

```ts
bot.hears(BTN.masterclasses, handleMasterclasses);
bot.hears(BTN.schedule, handleSchedule);
bot.hears(BTN.myRegs, handleMyRegs);
```

- [ ] **Step 3: Update `src/commands.ts`**

Replace `USER_COMMANDS` (lines 12-16):

```ts
const USER_COMMANDS = [
  { command: "mc", description: "Майстер-класи сьогодні" },
  { command: "schedule", description: "Розклад" },
  { command: "myevents", description: "Мої реєстрації" },
];
```

- [ ] **Step 4: Delete `src/events.ts` and `config.eventsTab`**

```bash
git rm src/events.ts
```

In `src/config.ts`, delete the line:

```ts
  eventsTab: "Events",
```

- [ ] **Step 5: Verify types and residue**

Run: `npm run typecheck`
Expected: PASS, no errors.

Run: `grep -rn "events\b\|loadEvents\|EventRegs" src/ --include="*.ts" | grep -v masterclasses.ts | grep -v registrationsTab`
Expected: no references to the deleted module (config `registrationsTab: "EventRegs"` remains — that tab is reused).

- [ ] **Step 6: Commit**

```bash
git add -A src/
git commit -m "feat: replace events with slot-based masterclass registration"
```

---

### Task 5: Responsible linking + admin commands

**Files:**
- Modify: `src/bot.ts` (responsible import line from Task 3, name-search handler, new callback + admin commands)
- Modify: `src/messages.ts` (add responsible strings)

**Interfaces:**
- Consumes (Task 2): `searchResponsibleByName`, `linkResponsibleRows`, `addResponsible`, `removeResponsible`; (Task 1): `loadMasterclasses`.
- Produces: callback format `link_resp:<rowIndex>` (rowIndex of one matched row; the handler links ALL unlinked rows sharing that row's name); admin commands `/addresp <mcId> <name>`, `/delresp <mcId> <name>`.

- [ ] **Step 1: Add messages**

In `src/messages.ts`, after the leader check-in block add:

```ts
  // Responsible check-in
  confirmResp: (name: string) =>
    `Це ви — відповідальний за майстер-клас?\n${name}\n\nНатисніть, щоб підтвердитись 👇`,
  respCheckedIn: (name: string, titles: string) =>
    `Готово, ${name}! Ви підключені як відповідальний за: ${titles} ✅`,
  respNotFound:
    "Не знайшли вас у списку відповідальних 😔 Зверніться до адміністратора.",
```

And after the admin commands block add:

```ts
  // Responsible admin commands
  addRespUsage: "Використання: /addresp <ID майстер-класу> <Прізвище та ім'я>",
  delRespUsage: "Використання: /delresp <ID майстер-класу> <Прізвище та ім'я>",
  mcNotFoundAdmin: (mcId: string) =>
    `Майстер-клас з ID ${mcId} не знайдено у каталозі.`,
  respAdded: (name: string, title: string) =>
    `${name} — відповідальний за «${title}» ✅`,
  respDuplicate: (name: string, title: string) =>
    `${name} вже відповідальний за «${title}».`,
  respRemoved: (name: string, title: string) =>
    `${name} більше не відповідальний за «${title}» ✅`,
  respNotFoundAdmin: (name: string, mcId: string) =>
    `Відповідального ${name} для МК ${mcId} не знайдено.`,
```

- [ ] **Step 2: Extend the responsible import in `src/bot.ts`**

Replace the import added in Task 3:

```ts
import { findResponsibleByTelegramId, loadResponsible } from "./responsible";
```

with:

```ts
import {
  addResponsible,
  findResponsibleByTelegramId,
  linkResponsibleRows,
  loadResponsible,
  removeResponsible,
  searchResponsibleByName,
} from "./responsible";
```

- [ ] **Step 3: Add the `link_resp` callback**

In `src/bot.ts`, immediately after the `link_leader` callback handler, add:

```ts
bot.callbackQuery(/^link_resp:(\d+)$/, async (ctx) => {
  const rowIndex = Number(ctx.match[1]);
  const sheet = await loadResponsible();

  const row = sheet.responsible.find((r) => r.rowIndex === rowIndex);
  if (!row) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.respNotFound);
  }
  if (row.telegramId && row.telegramId !== String(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.rowTaken);
  }

  // Links every unlinked row with this name — one person may run several MCs.
  const linked = await linkResponsibleRows(sheet, row.name, ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();

  const mcs = await loadMasterclasses();
  const titles = linked
    .map((r) => mcs.find((m) => m.id === r.mcId)?.title ?? `МК ${r.mcId}`)
    .join(", ");
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.respCheckedIn(row.name, titles), kb ? { reply_markup: kb } : {});
});
```

- [ ] **Step 4: Include responsible matches in the name search**

In the `bot.on("message:text", ...)` handler, replace the opening lines:

```ts
  const [sheet, leaderSheet] = await Promise.all([loadVisitors(), loadLeaders()]);

  const meVisitor = findByTelegramId(sheet.visitors, ctx.from.id);
  const meLeader = findLeadersByTelegramId(leaderSheet.leaders, ctx.from.id);

  // Always search for unlinked leader entries — a visitor can also be a leader.
  const leaderMatches = searchLeaderByName(leaderSheet.leaders, ctx.message.text);
  // Only search visitors if not yet linked as one.
  const visitorMatches = meVisitor ? [] : searchByName(sheet.visitors, ctx.message.text);

  if (visitorMatches.length === 0 && leaderMatches.length === 0) {
```

with:

```ts
  const [sheet, leaderSheet, respSheet] = await Promise.all([
    loadVisitors(),
    loadLeaders(),
    loadResponsible(),
  ]);

  const meVisitor = findByTelegramId(sheet.visitors, ctx.from.id);
  const meLeader = findLeadersByTelegramId(leaderSheet.leaders, ctx.from.id);

  // Always search unlinked leader/responsible entries — a visitor can also hold those roles.
  const leaderMatches = searchLeaderByName(leaderSheet.leaders, ctx.message.text);
  const respRows = searchResponsibleByName(respSheet.responsible, ctx.message.text);
  // One button per distinct person: the link_resp handler links all their rows at once.
  const respMatches = [...new Map(respRows.map((r) => [r.name.toLowerCase(), r])).values()];
  // Only search visitors if not yet linked as one.
  const visitorMatches = meVisitor ? [] : searchByName(sheet.visitors, ctx.message.text);

  if (visitorMatches.length === 0 && leaderMatches.length === 0 && respMatches.length === 0) {
```

Then replace the two single-match shortcuts and the combined listing:

```ts
  if (visitorMatches.length === 1 && leaderMatches.length === 0) {
    kb.text(visitorMatches[0].name, `link:${visitorMatches[0].rowIndex}`).row();
    return ctx.reply(M.confirmOne, { reply_markup: kb });
  }

  if (leaderMatches.length === 1 && visitorMatches.length === 0) {
    const l = leaderMatches[0];
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
    return ctx.reply(M.confirmLeader(l.name, l.team), { reply_markup: kb });
  }

  for (const v of visitorMatches) kb.text(v.name, `link:${v.rowIndex}`).row();
  for (const l of leaderMatches)
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();

  return ctx.reply(M.chooseYourself, { reply_markup: kb });
```

with:

```ts
  if (visitorMatches.length === 1 && leaderMatches.length === 0 && respMatches.length === 0) {
    kb.text(visitorMatches[0].name, `link:${visitorMatches[0].rowIndex}`).row();
    return ctx.reply(M.confirmOne, { reply_markup: kb });
  }

  if (leaderMatches.length === 1 && visitorMatches.length === 0 && respMatches.length === 0) {
    const l = leaderMatches[0];
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
    return ctx.reply(M.confirmLeader(l.name, l.team), { reply_markup: kb });
  }

  if (respMatches.length === 1 && visitorMatches.length === 0 && leaderMatches.length === 0) {
    const r = respMatches[0];
    kb.text(`🎨 ${r.name}`, `link_resp:${r.rowIndex}`).row();
    return ctx.reply(M.confirmResp(r.name), { reply_markup: kb });
  }

  for (const v of visitorMatches) kb.text(v.name, `link:${v.rowIndex}`).row();
  for (const l of leaderMatches)
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
  for (const r of respMatches) kb.text(`🎨 ${r.name}`, `link_resp:${r.rowIndex}`).row();

  return ctx.reply(M.chooseYourself, { reply_markup: kb });
```

- [ ] **Step 5: Add admin commands**

In `src/bot.ts`, after the `listleaders` command, add:

```ts
bot.command("addresp", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.addRespUsage);
  const [mcId, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const mcs = await loadMasterclasses();
  const mc = mcs.find((m) => m.id === mcId);
  if (!mc) return ctx.reply(M.mcNotFoundAdmin(mcId));
  const result = await addResponsible(mcId, name);
  if (result === "duplicate") return ctx.reply(M.respDuplicate(name, mc.title));
  return ctx.reply(M.respAdded(name, mc.title));
});

bot.command("delresp", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.delRespUsage);
  const [mcId, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const ok = await removeResponsible(mcId, name);
  if (!ok) return ctx.reply(M.respNotFoundAdmin(name, mcId));
  const mcs = await loadMasterclasses();
  const title = mcs.find((m) => m.id === mcId)?.title ?? `МК ${mcId}`;
  return ctx.reply(M.respRemoved(name, title));
});
```

No `src/commands.ts` change: both commands take arguments, and per the comment at `src/commands.ts:8-11` arg-taking commands are intentionally left out of the slash menus.

- [ ] **Step 6: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/bot.ts src/messages.ts
git commit -m "feat: responsible-person linking and addresp/delresp admin commands"
```

---

### Task 6: Responsible tools — attendee list and notify

**Files:**
- Modify: `src/bot.ts` (new handlers after the leader commands section, new hears lines)
- Modify: `src/messages.ts` (add strings)

**Interfaces:**
- Consumes (Tasks 1-3): `loadResponsible`, `findResponsibleByTelegramId`, `loadMasterclasses`, `loadMCSchedule`, `loadMCRegistrations`, `todaySlots`, `activeRegs`, `Masterclass`, `BTN.mcAttendees`, `BTN.mcNotify`.
- Produces: `/notifymc <text>` command; callback format `mn:<index>` where index points into the deterministic list built by `myOccurrencesToday` (today's slots in sheet order × that slot's MC IDs in listed order, filtered to the user's MCs). The notify text round-trips through the picker message («…»), same as the `renameteam` flow — no in-memory state.

- [ ] **Step 1: Add messages**

In `src/messages.ts`, after the leader keyboard hints, add:

```ts
  // Responsible tools
  notResponsible: "Ця функція доступна лише відповідальним за майстер-класи.",
  noMyMcToday: "Сьогодні ваших майстер-класів немає.",
  mcAttendeesHeader: (title: string, slot: string, place: string, taken: number, capacity: number) =>
    `🎨 ${title} — ${slot}, ${place} (${taken}${capacity > 0 ? `/${capacity}` : ""}):`,
  mcNoAttendees: "— поки нікого",
  mcNotifyNoText: "Використання: /notifymc <текст повідомлення>",
  mcNotifyHint: "Напишіть команду з текстом:\n/notifymc <ваше повідомлення>",
  mcNotifyChoose: (text: string) =>
    `Учасникам якого майстер-класу надіслати «${text}»?`,
  mcNotifySent: (sent: number, total: number, title: string, slot: string) =>
    `Надіслано ${sent}/${total} учасникам «${title}» (${slot}) ✅`,
```

- [ ] **Step 2: Import the `Masterclass` type in `src/bot.ts`**

Extend the masterclasses import (from Task 4) with the type:

```ts
import {
  activeRegs,
  loadMasterclasses,
  loadMCRegistrations,
  loadMCSchedule,
  Masterclass,
  register,
  todaySlots,
  unregister,
} from "./masterclasses";
```

- [ ] **Step 3: Add the responsible handlers**

In `src/bot.ts`, after the `renameteam`/`rt:` handlers (before the keyboard-button handlers section), add:

```ts
// --- responsible tools ---

interface MCOccurrence {
  date: string;
  slot: string;
  mc: Masterclass;
}

/** Today's occurrences of the user's masterclasses, in deterministic sheet order.
 *  Returns null if the user is not a responsible person. */
async function myOccurrencesToday(telegramId: number): Promise<MCOccurrence[] | null> {
  const { responsible } = await loadResponsible();
  const mine = findResponsibleByTelegramId(responsible, telegramId);
  if (mine.length === 0) return null;
  const myIds = [...new Set(mine.map((r) => r.mcId))];
  const [mcs, schedule] = await Promise.all([loadMasterclasses(), loadMCSchedule()]);
  const occ: MCOccurrence[] = [];
  for (const s of todaySlots(schedule)) {
    for (const id of s.mcIds) {
      if (!myIds.includes(id)) continue;
      const mc = mcs.find((m) => m.id === id);
      if (mc) occ.push({ date: s.date, slot: s.slot, mc });
    }
  }
  return occ;
}

async function handleMcAttendees(ctx: Context) {
  const occ = await myOccurrencesToday(ctx.from!.id);
  if (occ === null) return ctx.reply(M.notResponsible);
  if (occ.length === 0) return ctx.reply(M.noMyMcToday);
  const regs = await loadMCRegistrations();
  const lines: string[] = [];
  for (const o of occ) {
    const taken = activeRegs(regs, o.date, o.slot, o.mc.id);
    lines.push(M.mcAttendeesHeader(o.mc.title, o.slot, o.mc.place, taken.length, o.mc.capacity));
    if (taken.length === 0) lines.push(M.mcNoAttendees);
    for (const r of taken) lines.push(`• ${r.name}`);
    lines.push("");
  }
  return ctx.reply(lines.join("\n").trimEnd());
}

async function notifyOccurrence(ctx: Context, o: MCOccurrence, text: string) {
  const regs = await loadMCRegistrations();
  const taken = activeRegs(regs, o.date, o.slot, o.mc.id);
  const ids = [...new Set(taken.map((r) => r.telegramId))];
  let sent = 0;
  for (const id of ids) {
    try {
      await bot.api.sendMessage(id, text);
      sent++;
    } catch {
      // user blocked the bot or never started it
    }
  }
  return ctx.reply(M.mcNotifySent(sent, ids.length, o.mc.title, o.slot));
}

bot.command("notifymc", async (ctx) => {
  const text = ctx.match.trim();
  if (!text) return ctx.reply(M.mcNotifyNoText);
  const occ = await myOccurrencesToday(ctx.from!.id);
  if (occ === null) return ctx.reply(M.notResponsible);
  if (occ.length === 0) return ctx.reply(M.noMyMcToday);
  if (occ.length === 1) return notifyOccurrence(ctx, occ[0], text);
  const kb = new InlineKeyboard();
  occ.forEach((o, i) => kb.text(`${o.mc.title} (${o.slot})`, `mn:${i}`).row());
  return ctx.reply(M.mcNotifyChoose(text), { reply_markup: kb });
});

bot.callbackQuery(/^mn:(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  // The notify text is embedded in the picker message («…»), like the renameteam flow.
  const msgText = ctx.callbackQuery.message?.text ?? "";
  const textMatch = msgText.match(/«([\s\S]+)»/);
  if (!textMatch) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.mcNotifyNoText);
  }
  const occ = await myOccurrencesToday(ctx.from.id);
  const o = occ?.[idx];
  if (!o) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.noMyMcToday);
  }
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();
  return notifyOccurrence(ctx, o, textMatch[1]);
});
```

- [ ] **Step 4: Add the keyboard-button handlers**

In the keyboard-button handlers section, after `bot.hears(BTN.renameTeam, ...)`, add:

```ts
bot.hears(BTN.mcAttendees, handleMcAttendees);
bot.hears(BTN.mcNotify, (ctx) => ctx.reply(M.mcNotifyHint));
```

- [ ] **Step 5: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/bot.ts src/messages.ts
git commit -m "feat: attendee list and notify tools for masterclass responsible persons"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` (source modules table, sheets schema, role system, reply keyboards)

- [ ] **Step 1: Update `CLAUDE.md`**

In the source-modules table: replace the `events.ts` row with

```
| `masterclasses.ts` | Masterclass catalog, per-day/slot schedule, and registration CRUD (`EventRegs` tab) |
| `responsible.ts` | Responsible-person CRUD, search, and linking (mirrors `leaders.ts`) |
```

In the Google Sheets schema section: replace the `Events` and `EventRegs` bullets with

```
- **Masterclass catalog** — read-only from the grid spreadsheet (`GRID_SHEET_ID`), tab `5.Майстер-класи 2026`: columns `№ | Назва | Відповідальний | Місце проведення | … | Кількість учасників`. The header row is auto-detected (first row containing `Назва`); `№` like `1.` → ID `1`; capacity `без обмежень`/blank = unlimited; non-numeric-`№` rows (tournament tables) are skipped.
- **`MCSchedule`** — `Date | Slot | MC IDs` (date `YYYY-MM-DD`, slot shown verbatim, MC IDs comma-separated catalog `№` values).
- **`EventRegs`** — `Date | Slot | MC ID | Telegram ID | Name | Registered at | Cancelled at` (bot-managed masterclass registrations; one active registration per user per date+slot).
- **`MCResponsible`** — `MC ID | Name | Telegram ID | Added at` (bot-managed via `/addresp`; linked at check-in by name like leaders).
```

In the role system section, add after the Leader tier:

```
4. **Responsible** — rows in the `MCResponsible` sheet. Can view and message their masterclass attendees. Independent of the leader role; a person can hold both.
```

In the reply keyboards table, update to:

```
| Role | Buttons |
|---|---|
| Visitor | `🎨 Майстер-класи` · `🗓 Розклад` · `📋 Мої реєстрації` |
| Leader | Visitor buttons + `📢 Сповістити команду` · `✏️ Перейменувати команду` |
| Responsible | Visitor buttons + `👥 Учасники МК` · `📣 Сповістити учасників МК` (stacks with leader rows) |
```

- [ ] **Step 2: Final verification**

Run: `npm run typecheck`
Expected: PASS.

Run: `git log --oneline -8`
Expected: one commit per task above.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for the masterclasses migration"
```

---

## Manual follow-up (not part of the code tasks)

One-time sheet migration by the admin, then deploy:

1. Catalog: nothing to create — it already exists in the grid spreadsheet
   (`5.Майстер-класи 2026`); just keep `№`, `Назва`, `Місце проведення`,
   `Кількість учасників` filled. Make sure the service account can read `GRID_SHEET_ID`
   (it already does for the «Розклад» grid).
2. Create `MCSchedule` and `MCResponsible` tabs in the main spreadsheet with the headers
   above; fill the schedule dates/slots.
3. Replace the `EventRegs` header row with `Date | Slot | MC ID | Telegram ID | Name | Registered at | Cancelled at`; delete old data rows.
4. (Optional) delete the `Events` tab.
5. `npx vercel --prod` then `npm run set-webhook`.

## Self-Review

**Spec coverage:**
- Catalog reader (grid tab `5.Майстер-класи 2026`: header scan, `№` parse, `без обмежень`) + `MCSchedule`/`EventRegs` schema + readers → Task 1 ✓
- `register` with `ok|full|already|slot_taken`, soft-cancel `unregister` → Task 1 ✓
- `MCResponsible` + linking/search/CRUD → Task 2 ✓
- Button rename, role-composed keyboard (leader + responsible stack) → Task 3 ✓
- Visitor flow: one message per slot, `mcreg:`/`mcunreg:`, cancel-first, capacity, unknown-ID skip, `/mc`, my-registrations, `Розклад` fallback string, `events.ts` deleted → Task 4 ✓
- Check-in linking of responsible (all rows per person), `/addresp`/`/delresp` with catalog validation → Task 5 ✓
- Attendee list per occurrence, notify with picker (serverless-safe text round-trip) → Task 6 ✓
- CLAUDE.md + manual sheet migration checklist → Task 7 ✓

**Placeholder scan:** none — every code step contains complete code; every verify step has an exact command.

**Type consistency:** `Masterclass`/`SlotSchedule`/`MCRegistration`/`RegisterResult` (Task 1) match usage in Tasks 4 and 6; `Responsible`/`ResponsibleSheet`/`linkResponsibleRows` (Task 2) match Tasks 3 and 5; `roleKeyboard(opts)` and `BTN` keys (Task 3) match Tasks 4-6; `myOccurrencesToday` returns `MCOccurrence[] | null`, consumed with a null check in both Task 6 handlers.
