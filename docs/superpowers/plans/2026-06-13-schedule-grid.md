# Schedule Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 🗓 Розклад button show today's camp schedule, read live from the grid spreadsheet, with the currently-running activity highlighted by `▶`; fall back to the existing events list when the grid is unavailable.

**Architecture:** Add a spreadsheet-agnostic read to `sheets.ts`. A new `schedule.ts` module finds today's column by matching dates in the grid's header row, filters to non-empty time/activity slots, and flags the slot whose start time is the latest at or before now. `bot.ts`'s `handleSchedule` tries this first and falls back to `upcomingEvents()` on `null`.

**Tech Stack:** TypeScript, grammY, googleapis (Google Sheets v4). No test framework — verification is `npm run typecheck` and code inspection.

**Testing note:** This repo has no test runner or local dev server (per CLAUDE.md). Each task is verified with `npm run typecheck` (must pass clean) and by inspecting the diff against the spec. Runtime behavior is confirmed after deploy (`npx vercel --prod` + `npm run set-webhook`), which is out of scope for these tasks.

---

### Task 1: Spreadsheet-agnostic row reader

**Files:**
- Modify: `src/sheets.ts:12-18`

- [ ] **Step 1: Add `getRowsFromSpreadsheet` and delegate `getRows` to it**

Replace the existing `getRows` function (lines 12-18) with:

```ts
export async function getRowsFromSpreadsheet(
  spreadsheetId: string,
  tab: string,
): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab}'`,
  });
  return (res.data.values as string[][]) ?? [];
}

export async function getRows(tab: string): Promise<string[][]> {
  return getRowsFromSpreadsheet(config.sheetId, tab);
}
```

- [ ] **Step 2: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors. (All existing `getRows(tab)` callers are unchanged.)

- [ ] **Step 3: Commit**

```bash
git add src/sheets.ts
git commit -m "feat: add getRowsFromSpreadsheet for reading the grid spreadsheet"
```

---

### Task 2: `schedule.ts` — load today's schedule

**Files:**
- Create: `src/schedule.ts`

- [ ] **Step 1: Create the module**

Create `src/schedule.ts` with this exact content:

```ts
import { config, todayISO } from "./config";
import { getRowsFromSpreadsheet } from "./sheets";

const GRID_TAB = "3.Розклад табору 2026";

export interface ScheduleSlot {
  time: string;       // as shown in column A, e.g. "14:00"
  activity: string;   // activity text for today's column
  isCurrent: boolean; // true for the single highlighted slot, if any
}

export interface TodaySchedule {
  dayLabel: string;   // e.g. "Вівторок 04.08"
  slots: ScheduleSlot[];
}

/** Current Kyiv wall-clock time as minutes since midnight. */
function currentKyivMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/** Parse "H:MM" or "HH:MM" into minutes since midnight, or null. */
function parseMinutes(time: string): number | null {
  const m = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export async function loadTodaySchedule(): Promise<TodaySchedule | null> {
  if (!config.gridSheetId) return null;

  const rows = await getRowsFromSpreadsheet(config.gridSheetId, GRID_TAB);
  if (rows.length < 3) return null;

  // Row index 1 (sheet row 2) holds the day headers.
  const header = rows[1] ?? [];
  const today = todayISO(); // YYYY-MM-DD
  let colIdx = -1;
  let dayLabel = "";

  for (let c = 0; c < header.length; c++) {
    const cell = header[c] ?? "";
    const dateMatch = cell.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (!dateMatch) continue;
    const [, dd, mm, yyyy] = dateMatch;
    if (`${yyyy}-${mm}-${dd}` !== today) continue;
    colIdx = c;
    const weekday = cell.split(/[\n\r]/)[0]?.trim() ?? "";
    dayLabel = weekday ? `${weekday} ${dd}.${mm}` : `${dd}.${mm}`;
    break;
  }

  if (colIdx === -1) return null;

  // Collect non-empty slots from row index 2 onward.
  const slots: ScheduleSlot[] = [];
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const time = (row[0] ?? "").trim();
    const activity = (row[colIdx] ?? "").trim();
    if (!time || !activity) continue;
    slots.push({ time, activity, isCurrent: false });
  }

  // Highlight the last slot whose start time is <= now.
  const now = currentKyivMinutes();
  let currentIdx = -1;
  for (let i = 0; i < slots.length; i++) {
    const mins = parseMinutes(slots[i].time);
    if (mins !== null && mins <= now) currentIdx = i;
  }
  if (currentIdx !== -1) slots[currentIdx].isCurrent = true;

  return { dayLabel, slots };
}
```

- [ ] **Step 2: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Sanity-check the logic against the spec**

Confirm by inspection:
- `currentIdx` ends as the **last** index with `mins <= now` (loop does not break early) → correct "current activity" semantics.
- Rows with empty time **or** empty activity are skipped → empty cells don't become slots.
- `colIdx === -1` (no header date matches today) returns `null` → fallback path.
- Date reconstruction `${yyyy}-${mm}-${dd}` matches `todayISO()`'s `YYYY-MM-DD` format.

- [ ] **Step 4: Commit**

```bash
git add src/schedule.ts
git commit -m "feat: add loadTodaySchedule to read today's column from the grid"
```

---

### Task 3: Message formatters

**Files:**
- Modify: `src/messages.ts:17` (after the `scheduleTitle` line)

- [ ] **Step 1: Add the grid formatters**

In `src/messages.ts`, immediately after the `scheduleTitle: "Розклад подій:",` line (line 17), add:

```ts
  scheduleGridTitle: (dayLabel: string) => `📅 Розклад — ${dayLabel}`,
  scheduleGridLine: (slot: { time: string; activity: string; isCurrent: boolean }) =>
    `${slot.isCurrent ? "▶ " : ""}${slot.time} ${slot.activity}`,
```

- [ ] **Step 2: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/messages.ts
git commit -m "feat: add schedule grid message formatters"
```

---

### Task 4: Wire grid into `handleSchedule`

**Files:**
- Modify: `src/bot.ts:13-21` (events import block) and `src/bot.ts:160-171` (`handleSchedule`)

- [ ] **Step 1: Import `loadTodaySchedule`**

In `src/bot.ts`, add this import after the existing `events` import block (after line 21):

```ts
import { loadTodaySchedule } from "./schedule";
```

- [ ] **Step 2: Try the grid first in `handleSchedule`**

Replace the body of `handleSchedule` (currently lines 160-171) so it reads the grid first and falls back to the existing events rendering:

```ts
async function handleSchedule(ctx: Context) {
  const today = await loadTodaySchedule();
  if (today) {
    const lines = [
      M.scheduleGridTitle(today.dayLabel),
      "",
      ...today.slots.map((s) => M.scheduleGridLine(s)),
    ];
    return ctx.reply(lines.join("\n"));
  }

  const events = upcomingEvents(await loadEvents());
  if (events.length === 0) return ctx.reply(M.noEventsToday);
  const byDate = new Map<string, string[]>();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date)!.push(`  • ${eventLine(e)}`);
  }
  const lines = [M.scheduleTitle, ""];
  for (const [date, items] of byDate) lines.push(date, ...items, "");
  return ctx.reply(lines.join("\n"));
}
```

- [ ] **Step 3: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 4: Confirm wiring**

By inspection: `bot.hears(BTN.schedule, handleSchedule)` (line ~437) and
`bot.command("schedule", handleSchedule)` (line ~188) both still reference the same function — no
change needed there. The grid path returns before touching `loadEvents()`, so an available grid
never hits the events code.

- [ ] **Step 5: Commit**

```bash
git add src/bot.ts
git commit -m "feat: show today's grid schedule on the Розклад button"
```

---

## Self-Review

**Spec coverage:**
- `getRowsFromSpreadsheet` → Task 1 ✓
- `loadTodaySchedule` (column match, dayLabel, non-empty filter, `▶` on last slot ≤ now, `null` guards) → Task 2 ✓
- `scheduleGridTitle` / `scheduleGridLine` formatters → Task 3 ✓
- `handleSchedule` grid-first with events fallback → Task 4 ✓
- Edge cases (unset `gridSheetId`, outside camp dates, short Saturday column, unpadded times, before-first / after-last slot) → all handled by Task 2 logic ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `ScheduleSlot` / `TodaySchedule` shapes are identical across `schedule.ts`, the `scheduleGridLine` parameter, and the `handleSchedule` usage. `loadTodaySchedule(): Promise<TodaySchedule | null>` is consumed with a truthy `null` check. `getRowsFromSpreadsheet(spreadsheetId, tab)` signature matches its Task 1 definition and Task 2 call.
