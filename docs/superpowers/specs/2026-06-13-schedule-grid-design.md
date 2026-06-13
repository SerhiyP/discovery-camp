# Schedule Grid — Today's Column with Current-Activity Highlight

**Date:** 2026-06-13
**Status:** Approved design

## Goal

When a user taps the **🗓 Розклад** button, show the real camp schedule for **today**, read live
from the shared grid spreadsheet, with the **currently-running activity highlighted**. If today is
outside the camp dates (or the grid is unavailable), fall back to the existing event-list behavior.

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
  activity: string;   // activity text for today's column
  isCurrent: boolean; // true for the single highlighted slot, if any
}

export interface TodaySchedule {
  dayLabel: string;       // e.g. "Вівторок 04.08"
  slots: ScheduleSlot[];
}

export async function loadTodaySchedule(): Promise<TodaySchedule | null>
```

**Algorithm:**

1. If `config.gridSheetId` is empty → return `null`.
2. `rows = await getRowsFromSpreadsheet(config.gridSheetId, "3.Розклад табору 2026")`.
   If `rows.length < 3` → return `null`.
3. **Find today's column.** Take the header row at index 1. For each cell, match
   `/(\d{2})\.(\d{2})\.(\d{4})/`; if found, reconstruct `YYYY-MM-DD` and compare to `todayISO()`.
   The first matching cell gives `colIdx`. If none match → return `null` (outside camp dates).
4. **Build `dayLabel`.** From the matched header cell: take the weekday word (text before the first
   newline/date) and `DD.MM` from the matched date → `` `${weekday} ${DD}.${MM}` ``. If the weekday
   word is missing, fall back to `DD.MM`.
5. **Collect slots.** For each row from index 2 onward, read `time = row[0]` and
   `activity = row[colIdx]` (both trimmed). Keep the row **only if both are non-empty**.
6. **Mark current.** Compute current Kyiv time as minutes-since-midnight. Parse each slot's `time`
   (`H:MM` or `HH:MM`) into minutes. The highlighted slot is the **last** slot whose start ≤ now.
   If now is before the first slot, no slot is marked. Set `isCurrent` on that one slot only.
7. Return `{ dayLabel, slots }`.

**Helpers (private to the module):**
- `currentKyivMinutes(): number` — uses `Intl.DateTimeFormat` with `timeZone: config.timeZone`,
  `hour`/`minute` numeric, `hourCycle: "h23"`.
- `parseMinutes(time: string): number | null` — splits on `:`, returns `h*60+m` or `null`.

### 3. `src/messages.ts` — formatter

Add:

```ts
scheduleGridTitle: (dayLabel: string) => `📅 Розклад — ${dayLabel}`,
scheduleGridLine: (slot: { time: string; activity: string; isCurrent: boolean }) =>
  `${slot.isCurrent ? "▶ " : ""}${slot.time} ${slot.activity}`,
```

(Existing `scheduleTitle` / `noEventsToday` are kept for the fallback path.)

### 4. `src/bot.ts` — wire into `handleSchedule`

`handleSchedule(ctx)` first tries the grid:

```ts
const today = await loadTodaySchedule();
if (today) {
  const lines = [M.scheduleGridTitle(today.dayLabel), "", ...today.slots.map(M.scheduleGridLine)];
  return ctx.reply(lines.join("\n"));
}
// fall back to existing upcomingEvents() rendering
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
| `GRID_SHEET_ID` unset | `loadTodaySchedule()` returns `null` → events-list fallback |
| Today outside camp dates | No header matches → `null` → fallback |
| Grid tab renamed / unreachable | Sheets call returns `[]` or throws; `< 3` rows → `null`; a throw propagates to `handleSchedule` like the existing path |
| Now before first slot | No `▶` shown |
| Now after last slot | Last slot highlighted (e.g. `▶ 23:30 off`) |
| Short day column (Saturday) | Empty cells filtered out; `▶` lands on last real slot (`12:00 Час з командою`) |
| Times returned unpadded (`7:30`) | Parsed into minutes, so comparison still correct |

## Non-goals

- No day-selector / full-week browsing — today only.
- Column J ("Розклад по Легенді") is not shown.
- No caching — the grid is read on each tap (consistent with current event reads; camp scale).
- No change to the `Events`-based features (today's events, registrations).
