import { config, nowStamp, todayISO } from "./config";
import { M } from "./messages";
import { appendRow, getRows, headerIndex, updateCell } from "./sheets";

// The catalog and the schedule share the MCSchedule tab of the bot's spreadsheet:
// schedule columns (Date | Slot | MC IDs) on the left, catalog columns
// (№ | Назва | Відповідальний | Місце проведення | … | Кількість учасників |
// посилання на мапу) to the right of them. The two blocks are independent row-wise.

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

/** Raw rows of the MCSchedule tab — pass them to loadMasterclasses/loadMCSchedule
 *  to parse both from a single Sheets fetch. */
export async function loadMCTabRows(): Promise<string[][]> {
  return getRows(config.mcScheduleTab);
}

export async function loadMasterclasses(prefetched?: string[][]): Promise<Masterclass[]> {
  const rows = prefetched ?? (await loadMCTabRows());
  const headerRowIdx = rows.findIndex((r) => headerIndex(r, "Місце проведення") !== -1);
  if (headerRowIdx === -1) return [];
  const h = rows[headerRowIdx];
  const id = headerIndex(h, "№");
  if (id === -1) return [];
  // The title column may have no header of its own (E1:F1 are merged in the
  // sheet, so "№" spans both) — fall back to the column right after "№".
  const title = headerIndex(h, "Назва");
  const c = {
    id,
    title: title !== -1 ? title : id + 1,
    responsible: headerIndex(h, "Відповідальний"),
    place: headerIndex(h, "Місце проведення"),
    capacity: headerIndex(h, "Кількість учасників"),
  };
  const mcs: Masterclass[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    // "№" values look like "1." — canonical ID is "1". Rows without a numeric "№"
    // (blank separators) are skipped.
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

/** Splits a catalog "Відповідальний" cell into individual names, e.g.
 *  "Лєна Бабій і Інна Коляденко" -> ["Лєна Бабій", "Інна Коляденко"]. */
export function splitResponsibleNames(text: string): string[] {
  return text
    .split(/\s+(?:і|й|та)\s+|\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function loadMCSchedule(prefetched?: string[][]): Promise<SlotSchedule[]> {
  const rows = prefetched ?? (await loadMCTabRows());
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !slot || mcIds.length === 0) continue;
    slots.push({ date, slot, mcIds });
  }
  return slots;
}

/** Reads the topic-matrix block of the MCSchedule tab into a lookup keyed
 *  `${date}|${mcId}` -> topic. The block header row is `№ | Назва | <dates…>`
 *  (col A = "№", col B = "Назва"), distinct from the catalog header whose "№"
 *  is further right. Reuses prefetched tab rows; no extra fetch. Blank cells and
 *  rows without a numeric № are skipped. */
export async function loadMCTopics(prefetched?: string[][]): Promise<Map<string, string>> {
  const rows = prefetched ?? (await loadMCTabRows());
  const topics = new Map<string, string>();
  const headerRowIdx = rows.findIndex(
    (r) => (r[0] ?? "").trim() === "№" && (r[1] ?? "").trim() === "Назва",
  );
  if (headerRowIdx === -1) return topics;
  const header = rows[headerRowIdx];
  // Date columns: any header cell (past col B) that is an ISO date.
  const dateCols: { col: number; date: string }[] = [];
  for (let col = 2; col < header.length; col++) {
    const date = (header[col] ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dateCols.push({ col, date });
  }
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const idMatch = (row[0] ?? "").trim().match(/^(\d+)\.?$/);
    if (!idMatch) continue;
    const id = idMatch[1];
    for (const { col, date } of dateCols) {
      const topic = (row[col] ?? "").trim();
      if (topic) topics.set(`${date}|${id}`, topic);
    }
  }
  return topics;
}

/** One `📌 <title>: <topic>` line per MC in `mcIds` that has a topic on `date`.
 *  MCs without a topic (or unknown IDs) produce no line. Order follows `mcIds`. */
export function topicLines(
  mcIds: string[],
  mcs: Masterclass[],
  topics: Map<string, string>,
  date: string,
): string[] {
  const lines: string[] = [];
  for (const id of mcIds) {
    const topic = topics.get(`${date}|${id}`);
    if (!topic) continue;
    const mc = mcs.find((m) => m.id === id);
    if (!mc) continue;
    lines.push(M.mcTopicLine(mc.title, topic));
  }
  return lines;
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

export function hasActiveRegistrationForSlot(
  regs: MCRegistration[],
  date: string,
  slot: string,
  telegramId: string,
): boolean {
  return regs.some(
    (r) => r.date === date && r.slot === slot && r.telegramId === telegramId && !r.cancelled,
  );
}

export interface MCButton {
  label: string;
  cbData: string;
}

/** Builds the registration buttons for one slot. Pass `viewerTelegramId` to mark
 *  the viewer's own registration (❌, tap to cancel); omit it for a mine-blind
 *  view (e.g. a reminder broadcast where every recipient is already unregistered). */
export function buildSlotButtons(
  s: SlotSchedule,
  mcs: Masterclass[],
  regs: MCRegistration[],
  viewerTelegramId?: string,
): MCButton[] {
  const buttons: MCButton[] = [];
  for (const id of s.mcIds) {
    const mc = mcs.find((m) => m.id === id);
    if (!mc) continue; // unknown ID in MCSchedule (or empty catalog) — skip silently
    const taken = activeRegs(regs, s.date, s.slot, mc.id);
    const mine = viewerTelegramId ? taken.some((r) => r.telegramId === viewerTelegramId) : false;
    const cbData = `${mine ? "mcunreg" : "mcreg"}:${s.date}:${s.slot}:${mc.id}`;
    // Telegram rejects the whole message if any button's callback data exceeds 64 bytes
    if (Buffer.byteLength(cbData) > 64) continue;
    const label = `${mine ? "❌" : "📝"} ${mc.title}${
      mc.capacity > 0 ? ` — ${taken.length}/${mc.capacity}` : ""
    }`;
    buttons.push({ label, cbData });
  }
  return buttons;
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
