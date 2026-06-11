import { config, nowStamp } from "./config";
import { getRows, headerIndex, updateCell } from "./sheets";

export interface Visitor {
  rowIndex: number; // 0-based, including header row
  name: string;
  team: string;
  telegramId: string;
  checkedIn: string;
}

interface VisitorSheet {
  visitors: Visitor[];
  cols: { name: number; checkin: number; telegramId: number; team: number };
}

export async function loadVisitors(): Promise<VisitorSheet> {
  const rows = await getRows(config.responsesTab);
  if (rows.length === 0) throw new Error(`Tab "${config.responsesTab}" is empty`);

  const header = rows[0];
  const cols = {
    name: headerIndex(header, config.nameHeader),
    checkin: headerIndex(header, config.checkinHeader),
    telegramId: headerIndex(header, config.telegramIdHeader),
    team: config.teamHeader ? headerIndex(header, config.teamHeader) : -1,
  };
  if (cols.name === -1)
    throw new Error(`Column "${config.nameHeader}" not found in "${config.responsesTab}"`);
  if (cols.checkin === -1 || cols.telegramId === -1)
    throw new Error(
      `Add columns "${config.checkinHeader}" and "${config.telegramIdHeader}" to "${config.responsesTab}"`,
    );

  const visitors: Visitor[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = (row[cols.name] ?? "").trim();
    if (!name) continue;
    visitors.push({
      rowIndex: i,
      name,
      team: cols.team >= 0 ? (row[cols.team] ?? "").trim() : "",
      telegramId: (row[cols.telegramId] ?? "").trim(),
      checkedIn: (row[cols.checkin] ?? "").trim(),
    });
  }
  return { visitors, cols };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’'ʼ`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every word of the query must be a prefix of some word of the name
 * ("іван петр" matches "Петренко Іван"). Exact full match ranks first.
 */
export function searchByName(visitors: Visitor[], query: string): Visitor[] {
  const q = normalize(query);
  if (!q) return [];
  const qTokens = q.split(" ");

  const scored = visitors
    .map((v) => {
      const n = normalize(v.name);
      const nTokens = n.split(" ");
      if (n === q) return { v, score: 2 };
      const allMatch = qTokens.every((qt) =>
        nTokens.some((nt) => nt.startsWith(qt)),
      );
      return { v, score: allMatch ? 1 : 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 5).map((s) => s.v);
}

export function findByTelegramId(
  visitors: Visitor[],
  telegramId: number,
): Visitor | undefined {
  return visitors.find((v) => v.telegramId === String(telegramId));
}

/**
 * Links a Telegram account to a sheet row and marks check-in.
 * Returns false if the row is already linked to a different account.
 */
export async function linkAndCheckIn(
  sheet: VisitorSheet,
  rowIndex: number,
  telegramId: number,
): Promise<{ ok: boolean; visitor?: Visitor }> {
  const visitor = sheet.visitors.find((v) => v.rowIndex === rowIndex);
  if (!visitor) return { ok: false };
  if (visitor.telegramId && visitor.telegramId !== String(telegramId))
    return { ok: false, visitor };

  await updateCell(config.responsesTab, rowIndex, sheet.cols.telegramId, String(telegramId));
  if (!visitor.checkedIn)
    await updateCell(config.responsesTab, rowIndex, sheet.cols.checkin, nowStamp());
  return { ok: true, visitor };
}

/** Team -> video file_id from the Videos tab; falls back to DEFAULT_VIDEO_FILE_ID. */
export async function videoForTeam(team: string): Promise<string> {
  try {
    const rows = await getRows(config.videosTab);
    const target = normalize(team);
    for (let i = 1; i < rows.length; i++) {
      const [t, fileId] = rows[i];
      if (t && fileId && normalize(t) === target) return fileId.trim();
    }
  } catch {
    // Videos tab is optional
  }
  return config.defaultVideoFileId;
}
