import { config, nowStamp, todayISO } from "./config";
import { appendRow, getRows, headerIndex, updateCell } from "./sheets";

export interface CampEvent {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // e.g. "10:00"
  title: string;
  capacity: number; // 0 = unlimited
}

export interface Registration {
  rowIndex: number;
  eventId: string;
  telegramId: string;
  name: string;
  cancelled: boolean;
}

export async function loadEvents(): Promise<CampEvent[]> {
  const rows = await getRows(config.eventsTab);
  if (rows.length === 0) return [];
  const h = rows[0];
  const c = {
    id: headerIndex(h, "ID"),
    date: headerIndex(h, "Date"),
    time: headerIndex(h, "Time"),
    title: headerIndex(h, "Title"),
    capacity: headerIndex(h, "Capacity"),
  };
  const events: CampEvent[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const id = (row[c.id] ?? "").trim();
    const title = (row[c.title] ?? "").trim();
    if (!id || !title) continue;
    events.push({
      id,
      date: (row[c.date] ?? "").trim(),
      time: (row[c.time] ?? "").trim(),
      title,
      capacity: Number(row[c.capacity] ?? 0) || 0,
    });
  }
  return events;
}

export async function loadRegistrations(): Promise<Registration[]> {
  const rows = await getRows(config.registrationsTab);
  const regs: Registration[] = [];
  for (let i = 1; i < rows.length; i++) {
    const [eventId, telegramId, name, , cancelled] = rows[i];
    if (!eventId || !telegramId) continue;
    regs.push({
      rowIndex: i,
      eventId: eventId.trim(),
      telegramId: telegramId.trim(),
      name: (name ?? "").trim(),
      cancelled: (cancelled ?? "").trim() !== "",
    });
  }
  return regs;
}

export function activeRegs(regs: Registration[], eventId: string): Registration[] {
  return regs.filter((r) => r.eventId === eventId && !r.cancelled);
}

export function todayEvents(events: CampEvent[]): CampEvent[] {
  const today = todayISO();
  return events.filter((e) => e.date === today);
}

export function upcomingEvents(events: CampEvent[]): CampEvent[] {
  const today = todayISO();
  return events.filter((e) => e.date >= today);
}

export type RegisterResult = "ok" | "full" | "already";

export async function register(
  eventId: string,
  capacity: number,
  telegramId: number,
  name: string,
): Promise<RegisterResult> {
  const regs = await loadRegistrations();
  const active = activeRegs(regs, eventId);
  if (active.some((r) => r.telegramId === String(telegramId))) return "already";
  if (capacity > 0 && active.length >= capacity) return "full";
  await appendRow(config.registrationsTab, [
    eventId,
    String(telegramId),
    name,
    nowStamp(),
    "",
  ]);
  return "ok";
}

export async function unregister(eventId: string, telegramId: number): Promise<boolean> {
  const regs = await loadRegistrations();
  const mine = activeRegs(regs, eventId).find(
    (r) => r.telegramId === String(telegramId),
  );
  if (!mine) return false;
  // column E = "Cancelled at"
  await updateCell(config.registrationsTab, mine.rowIndex, 4, nowStamp());
  return true;
}
