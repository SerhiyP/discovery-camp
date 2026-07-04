import { config, todayISO } from "./config";
import { getRowsFromSpreadsheet } from "./sheets";

const GRID_TAB = "3.Розклад табору 2026";

const CAMP_START = "2026-08-03";
const CAMP_END   = "2026-08-07";

export interface ScheduleSlot {
  time: string;       // e.g. "14:00"
  activity: string;   // activity label from the badge schedule
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
  | { status: "unavailable" }; // grid not configured / unreadable

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
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Format a YYYY-MM-DD date as "DD.MM" with Ukrainian weekday prefix. */
function formatDayLabel(dateISO: string): string {
  const date = new Date(`${dateISO}T12:00:00`);
  const weekday = new Intl.DateTimeFormat("uk-UA", { weekday: "long" }).format(date);
  const [, mm, dd] = dateISO.match(/(\d{4})-(\d{2})-(\d{2})/) ?? [];
  const capitalized = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${capitalized} ${dd}.${mm}`;
}

export async function loadTodaySchedule(): Promise<ScheduleResult> {
  if (!config.gridSheetId) return { status: "unavailable" };

  const today = todayISO(); // YYYY-MM-DD

  if (today > CAMP_END)   return { status: "finished" };

  // Before or during camp: show today's schedule, or the first day if not started yet.
  const targetDate = today < CAMP_START ? CAMP_START : today;
  const isToday = targetDate === today;
  const dayLabel = formatDayLabel(targetDate);

  const rows = await getRowsFromSpreadsheet(config.gridSheetId, GRID_TAB);
  if (rows.length < 3) return { status: "unavailable" };

  // Collect non-empty slots from the badge schedule (col 8 = time, col 9 = activity).
  const slots: ScheduleSlot[] = [];
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const time = (row[8] ?? "").trim();
    const activity = (row[9] ?? "").trim();
    if (!time || !activity) continue;
    slots.push({ time, activity, isCurrent: false });
  }

  if (slots.length === 0) return { status: "unavailable" };

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
