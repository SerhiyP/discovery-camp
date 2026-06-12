import { config, nowStamp } from "./config";
import { appendRow, getRows, headerIndex, updateCell } from "./sheets";

export interface Visitor {
  rowIndex: number; // 0-based, including header row
  name: string;
  team: string;
  room: string;
  telegramId: string;
  checkedIn: string;
}

interface VisitorSheet {
  visitors: Visitor[];
  cols: { name: number; checkin: number; telegramId: number; team: number; room: number };
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
    room: config.roomHeader ? headerIndex(header, config.roomHeader) : -1,
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
      room: cols.room >= 0 ? (row[cols.room] ?? "").trim() : "",
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

/** Team ID -> video from the Videos tab; falls back to DEFAULT_VIDEO_FILE_ID. Returns null if nothing configured. */
export async function videoForTeam(
  teamId: string,
): Promise<{ fileId: string; isVideoNote: boolean } | null> {
  try {
    const rows = await getRows(config.videosTab);
    if (rows.length === 0) {
      if (config.defaultVideoFileId) return { fileId: config.defaultVideoFileId, isVideoNote: false };
      return null;
    }
    const header = rows[0];
    const idCol = headerIndex(header, "ID");
    const fileIdCol = headerIndex(header, "File ID");
    const typeCol = headerIndex(header, "Type");
    const target = teamId.trim();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const id = (row[idCol] ?? "").trim();
      const fileId = (row[fileIdCol] ?? "").trim();
      if (id === target && fileId) {
        const type = (row[typeCol] ?? "").trim();
        return { fileId, isVideoNote: type === "video_note" };
      }
    }
  } catch {
    // Videos tab is optional
  }
  if (config.defaultVideoFileId) return { fileId: config.defaultVideoFileId, isVideoNote: false };
  return null;
}

/** Updates or inserts a team's video file_id and type in the Videos tab. */
export async function updateTeamVideo(
  teamId: string,
  fileId: string,
  isVideoNote: boolean,
): Promise<void> {
  const rows = await getRows(config.videosTab);
  const type = isVideoNote ? "video_note" : "video";
  const target = teamId.trim();

  if (rows.length > 0) {
    const header = rows[0];
    const idCol = headerIndex(header, "ID");
    const fileIdCol = headerIndex(header, "File ID");
    const typeCol = headerIndex(header, "Type");
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][idCol] ?? "").trim() === target) {
        await updateCell(config.videosTab, i, fileIdCol, fileId);
        await updateCell(config.videosTab, i, typeCol, type);
        return;
      }
    }
  }
  // Row not found — append. ID and Team are both set to teamId.
  await appendRow(config.videosTab, [teamId, teamId, fileId, type]);
}

/** Bulk-updates the team column in the responses sheet for all visitors on oldName. Returns count updated. */
export async function renameVisitorTeams(oldName: string, newName: string): Promise<number> {
  const sheet = await loadVisitors();
  if (sheet.cols.team < 0) return 0;
  let count = 0;
  for (const v of sheet.visitors) {
    if (v.team.toLowerCase() === oldName.toLowerCase()) {
      await updateCell(config.responsesTab, v.rowIndex, sheet.cols.team, newName);
      count++;
    }
  }
  return count;
}

/** Updates the team name in the Videos tab when a team is renamed. */
export async function renameTeamVideo(oldName: string, newName: string): Promise<void> {
  const rows = await getRows(config.videosTab);
  const target = oldName.trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] ?? "").trim().toLowerCase() === target) {
      await updateCell(config.videosTab, i, 0, newName);
      return;
    }
  }
}
