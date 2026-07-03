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
