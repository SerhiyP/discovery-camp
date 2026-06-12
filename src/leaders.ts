import { config, nowStamp } from "./config";
import { appendRow, clearRow, getRows, headerIndex, updateCell } from "./sheets";

export interface Leader {
  rowIndex: number;
  team: string;
  name: string;
  telegramId: string;
  addedAt: string;
}

export interface LeaderSheet {
  leaders: Leader[];
  cols: { team: number; name: number; telegramId: number; addedAt: number };
}

export async function loadLeaders(): Promise<LeaderSheet> {
  const rows = await getRows(config.leadersTab);
  if (rows.length === 0) {
    return { leaders: [], cols: { team: 0, name: 1, telegramId: 2, addedAt: 3 } };
  }
  const header = rows[0];
  const cols = {
    team: headerIndex(header, "Team"),
    name: headerIndex(header, "Name"),
    telegramId: headerIndex(header, "Telegram ID"),
    addedAt: headerIndex(header, "Added at"),
  };
  const leaders: Leader[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const team = (row[cols.team] ?? "").trim();
    const name = (row[cols.name] ?? "").trim();
    if (!team && !name) continue; // cleared row
    leaders.push({
      rowIndex: i,
      team,
      name,
      telegramId: (row[cols.telegramId] ?? "").trim(),
      addedAt: (row[cols.addedAt] ?? "").trim(),
    });
  }
  return { leaders, cols };
}

export function findLeadersByTelegramId(leaders: Leader[], telegramId: number): Leader[] {
  return leaders.filter((l) => l.telegramId === String(telegramId));
}

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[''ʼ`]/g, "").replace(/\s+/g, " ").trim();
}

/** Returns unlinked leaders matching the query (same prefix-match logic as visitor search). */
export function searchLeaderByName(leaders: Leader[], query: string): Leader[] {
  const q = normalizeStr(query);
  if (!q) return [];
  const qTokens = q.split(" ");
  return leaders
    .filter((l) => !l.telegramId)
    .filter((l) => {
      const nTokens = normalizeStr(l.name).split(" ");
      return qTokens.every((qt) => nTokens.some((nt) => nt.startsWith(qt)));
    });
}

export async function setLeaderTelegramId(
  sheet: LeaderSheet,
  rowIndex: number,
  telegramId: number,
): Promise<void> {
  await updateCell(config.leadersTab, rowIndex, sheet.cols.telegramId, String(telegramId));
}

export async function addLeader(team: string, name: string): Promise<"ok" | "full" | "duplicate"> {
  const { leaders } = await loadLeaders();
  const teamLeaders = leaders.filter((l) => l.team.toLowerCase() === team.toLowerCase());
  if (teamLeaders.length >= 3) return "full";
  if (teamLeaders.some((l) => l.name.toLowerCase() === name.toLowerCase())) return "duplicate";
  await appendRow(config.leadersTab, [team, name, "", nowStamp()]);
  return "ok";
}

export async function removeLeader(team: string, name: string): Promise<boolean> {
  const { leaders } = await loadLeaders();
  const leader = leaders.find(
    (l) =>
      l.team.toLowerCase() === team.toLowerCase() &&
      l.name.toLowerCase() === name.toLowerCase(),
  );
  if (!leader) return false;
  await clearRow(config.leadersTab, leader.rowIndex);
  return true;
}

/** Updates Team column in Leaders tab for all rows matching oldName. Returns count updated. */
export async function renameLeaderTeams(oldName: string, newName: string): Promise<number> {
  const { leaders, cols } = await loadLeaders();
  let count = 0;
  for (const l of leaders) {
    if (l.team.toLowerCase() === oldName.toLowerCase()) {
      await updateCell(config.leadersTab, l.rowIndex, cols.team, newName);
      count++;
    }
  }
  return count;
}
