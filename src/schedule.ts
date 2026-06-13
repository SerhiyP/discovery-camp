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
