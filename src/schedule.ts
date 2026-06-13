import { config, todayISO } from "./config";
import { getRowsFromSpreadsheet } from "./sheets";

const GRID_TAB = "3.Розклад табору 2026";

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
  | { status: "finished" }    // today is past the last camp day
  | { status: "unavailable" }; // grid not configured / unreadable / no dated columns

interface GridColumn {
  colIdx: number;
  dateISO: string; // YYYY-MM-DD
  dd: string;
  mm: string;
  weekday: string;
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

/** Parse the dated day-header columns from the header row (sheet row 2). */
function parseColumns(header: string[]): GridColumn[] {
  const cols: GridColumn[] = [];
  for (let c = 0; c < header.length; c++) {
    const cell = header[c] ?? "";
    const dateMatch = cell.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (!dateMatch) continue;
    const [, dd, mm, yyyy] = dateMatch;
    const weekday = cell.split(/[\n\r]/)[0]?.trim() ?? "";
    cols.push({ colIdx: c, dateISO: `${yyyy}-${mm}-${dd}`, dd, mm, weekday });
  }
  return cols;
}

export async function loadTodaySchedule(): Promise<ScheduleResult> {
  if (!config.gridSheetId) return { status: "unavailable" };

  const rows = await getRowsFromSpreadsheet(config.gridSheetId, GRID_TAB);
  if (rows.length < 3) return { status: "unavailable" };

  // Row index 1 (sheet row 2) holds the day headers.
  const cols = parseColumns(rows[1] ?? []);
  if (cols.length === 0) return { status: "unavailable" };

  cols.sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  const today = todayISO(); // YYYY-MM-DD

  // After the camp's last day → finished.
  if (today > cols[cols.length - 1].dateISO) return { status: "finished" };

  // First column on or after today: today's column during camp,
  // or the first day when the camp hasn't started yet.
  const target = cols.find((c) => c.dateISO >= today)!;
  const isToday = target.dateISO === today;
  const dayLabel = target.weekday
    ? `${target.weekday} ${target.dd}.${target.mm}`
    : `${target.dd}.${target.mm}`;

  // Collect non-empty slots from row index 2 onward.
  const slots: ScheduleSlot[] = [];
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const time = (row[0] ?? "").trim();
    const activity = (row[target.colIdx] ?? "").trim();
    if (!time || !activity) continue;
    slots.push({ time, activity, isCurrent: false });
  }

  // Highlight the current activity only when the shown day is actually today.
  if (isToday) {
    const now = currentKyivMinutes();
    let currentIdx = -1;
    for (let i = 0; i < slots.length; i++) {
      const mins = parseMinutes(slots[i].time);
      if (mins !== null && mins <= now) currentIdx = i;
    }
    if (currentIdx !== -1) slots[currentIdx].isCurrent = true;
  }

  return { status: "ok", schedule: { dayLabel, slots, isToday } };
}
