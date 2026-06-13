# Schedule Grid — Today's Column with Current-Activity Highlight

**Date:** 2026-06-13
**Status:** Approved design

## Goal

When a user taps the **🗓 Розклад** button, show the real camp schedule read live from the shared
grid spreadsheet, adapting to the camp phase:

- **During camp** — today's column, with the **currently-running activity highlighted**.
- **Before camp** — the **first day's** column (no highlight), prefixed by a "camp hasn't started"
  note.
- **After camp** — a thank-you "camp finished" message (no schedule).
- **Grid unavailable** (env unset / unreadable / no dated columns) — fall back to the existing
  event-list behavior.

## Background

- The grid lives in a **separate** read-only spreadsheet, already configured as
  `config.gridSheetId` (env var `GRID_SHEET_ID`). Currently nothing reads from it.
- Tab name: **`3.Розклад табору 2026`**
- Layout:
  - **Column A** — time slots (`07:30`, `08:00`, …), shared across all days.
  - **Row 2** (0-based index 1) — day headers, each a two-line cell like `Понеділок\n03.08.2026 р.`
  - **Columns B–G** — one column per day (Mon 03.08 – Sat 08.08), activity text per time slot.
  - Column J ("Розклад по Легенді") — **ignored**.
- An activity occupies the row where it is introduced and runs until the **next non-empty**
  activity in that day's column. Empty activity cells therefore mean "previous activity still
  running" and are **not** separate slots.
- The existing **🗓 Розклад** handler (`handleSchedule` in `bot.ts`) lists `upcomingEvents()` from
  the main spreadsheet's `Events` tab. This stays as the fallback.

## Approach

Read the day headers live and match today's date against them (chosen over hard-coded column maps
so the feature survives any column reordering and needs zero extra config).

## Changes

### 1. `src/sheets.ts` — read from an arbitrary spreadsheet

Add:

```ts
export async function getRowsFromSpreadsheet(
  spreadsheetId: string,
  tab: string,
): Promise<string[][]>
```

Identical to the current `getRows` body but parameterized on `spreadsheetId`. Refactor the existing
`getRows(tab)` to delegate: `return getRowsFromSpreadsheet(config.sheetId, tab)`. No behavior change
for existing callers.

### 2. `src/schedule.ts` — new module

```ts
export interface ScheduleSlot {
  time: string;       // as shown in column A, e.g. "14:00"
  activity: string;   // activity text for the shown day's column
  isCurrent: boolean; // true for the single highlighted slot, if any
}

export interface DaySchedule {
  dayLabel: string;   // e.g. "Вівторок 04.08"
  slots: ScheduleSlot[];
  isToday: boolean;   // false when showing the first day before the camp starts
}

export type ScheduleResult =
  | { status: "ok"; schedule: DaySchedule }
  | { status: "finished" }     // today is past the last camp day
  | { status: "unavailable" }; // grid not configured / unreadable / no dated columns

export async function loadTodaySchedule(): Promise<ScheduleResult>
```

**Algorithm:**

1. If `config.gridSheetId` is empty → `{ status: "unavailable" }`.
2. `rows = await getRowsFromSpreadsheet(config.gridSheetId, "3.Розклад табору 2026")`.
   If `rows.length < 3` → `{ status: "unavailable" }`.
3. **Parse dated columns.** From the header row at index 1, for each cell match
   `/(\d{2})\.(\d{2})\.(\d{4})/`; for each match record `{ colIdx, dateISO (YYYY-MM-DD), dd, mm,
   weekday }` where `weekday` is the text before the first newline. If no cell matches →
   `{ status: "unavailable" }`. Sort columns by `dateISO`.
4. **Pick the phase.**
   - If `todayISO() > lastColumn.dateISO` → `{ status: "finished" }` (camp is over).
   - Otherwise `target` = first column with `dateISO >= todayISO()` (today's column during camp, or
     the first day when the camp hasn't started). `isToday = target.dateISO === todayISO()`.
5. **Build `dayLabel`.** `` `${weekday} ${dd}.${mm}` `` from `target`, or `` `${dd}.${mm}` `` if the
   weekday word is missing.
6. **Collect slots.** For each row from index 2 onward, read `time = row[0]` and
   `activity = row[target.colIdx]` (both trimmed). Keep the row **only if both are non-empty**.
7. **Mark current — only when `isToday`.** Compute current Kyiv time as minutes-since-midnight; parse
   each slot's `time` (`H:MM`/`HH:MM`) into minutes; highlight the **last** slot whose start ≤ now.
   When `!isToday` (pre-camp first day) no slot is highlighted, since nothing is running yet.
8. Return `{ status: "ok", schedule: { dayLabel, slots, isToday } }`.

**Helpers (private to the module):**
- `currentKyivMinutes(): number` — uses `Intl.DateTimeFormat` with `timeZone: config.timeZone`,
  `hour`/`minute` numeric, `hourCycle: "h23"`.
- `parseMinutes(time: string): number | null` — matches `^(\d{1,2}):(\d{2})$`, returns `h*60+m`.
- `parseColumns(header: string[]): GridColumn[]` — extracts the dated day-header columns.

String date comparison on `YYYY-MM-DD` is used throughout (lexicographic order == chronological).

### 3. `src/messages.ts` — strings

Add:

```ts
scheduleGridTitle: (dayLabel: string) => `📅 Розклад — ${dayLabel}`,
scheduleGridLine: (slot: { time: string; activity: string; isCurrent: boolean }) =>
  `${slot.isCurrent ? "▶ " : ""}${slot.time} ${slot.activity}`,
scheduleNotStarted: "Табір ще не розпочався.\nОсь розклад першого дня:",
scheduleCampFinished: "Табір завершено.\nДякуємо, що були з нами! 🎉",
```

(Existing `scheduleTitle` / `noEventsToday` are kept for the fallback path.)

### 4. `src/bot.ts` — wire into `handleSchedule`

`handleSchedule(ctx)` branches on the result status:

```ts
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
// status === "unavailable" → fall back to existing upcomingEvents() rendering
```

The `bot.hears(BTN.schedule, handleSchedule)` and `bot.command("schedule", handleSchedule)`
registrations are unchanged.

## Example output

At 14:30 on Tuesday 04.08:

```
📅 Розклад — Вівторок 04.08

07:30 Ранкова молитва/команда
08:20 Загальна молитва/гімн/перевірка віршів
08:30 Зарядка
09:00 Сніданок
10:00 Ранкове служіння
11:00 Обговорення
12:00 Майстер класи + турніри
13:00 Обід
▶ 14:00 Майстер класи
15:30 Ігри
18:00 Вечеря
19:00 Вечірнє служіння
20:30 Обговорення
22:00 Discovery
23:30 off
```

## Edge cases

| Case | Behavior |
|---|---|
| `GRID_SHEET_ID` unset | `{ status: "unavailable" }` → events-list fallback |
| Grid tab renamed / unreachable / no dated columns | `< 3` rows or no header dates → `unavailable` → fallback; a hard throw propagates to `handleSchedule` like the existing path |
| Today before the first camp day | First day's column shown, prefixed by `scheduleNotStarted`, **no** `▶` highlight |
| Today after the last camp day | `{ status: "finished" }` → thank-you message, no schedule |
| Now before first slot (during camp) | No `▶` shown |
| Now after last slot (during camp) | Last slot highlighted (e.g. `▶ 23:30 off`) |
| Short day column (Saturday) | Empty cells filtered out; `▶` lands on last real slot (`12:00 Час з командою`) |
| Times returned unpadded (`7:30`) | Parsed into minutes, so comparison still correct |

## Non-goals

- No day-selector / full-week browsing — today only.
- Column J ("Розклад по Легенді") is not shown.
- No caching — the grid is read on each tap (consistent with current event reads; camp scale).
- No change to the `Events`-based features (today's events, registrations).
