import { config, nowStamp } from "./config";
import { appendRow, clearRow, getRows, headerIndex } from "./sheets";

export interface Admin {
  rowIndex: number;
  telegramId: string;
  name: string;
  addedAt: string;
}

export interface AdminSheet {
  admins: Admin[];
  cols: { telegramId: number; name: number; addedAt: number };
}

export async function loadAdmins(): Promise<AdminSheet> {
  const rows = await getRows(config.adminsTab);
  if (rows.length === 0) {
    return { admins: [], cols: { telegramId: 0, name: 1, addedAt: 2 } };
  }
  const header = rows[0];
  const cols = {
    telegramId: headerIndex(header, "Telegram ID"),
    name: headerIndex(header, "Name"),
    addedAt: headerIndex(header, "Added at"),
  };
  const admins: Admin[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const telegramId = (row[cols.telegramId] ?? "").trim();
    const name = (row[cols.name] ?? "").trim();
    if (!telegramId && !name) continue; // cleared row
    admins.push({ rowIndex: i, telegramId, name, addedAt: (row[cols.addedAt] ?? "").trim() });
  }
  return { admins, cols };
}

/** Returns true if userId is a superadmin (env) or in the Admins sheet. */
export function isAdmin(userId: number | undefined, admins: Admin[]): boolean {
  if (!userId) return false;
  if (config.adminIds.includes(userId)) return true;
  return admins.some((a) => a.telegramId === String(userId));
}

export function findAdminByTelegramId(admins: Admin[], telegramId: number): Admin | undefined {
  return admins.find((a) => a.telegramId === String(telegramId));
}

export async function addAdmin(telegramId: string, name: string): Promise<"ok" | "duplicate"> {
  const { admins } = await loadAdmins();
  if (admins.some((a) => a.telegramId === telegramId)) return "duplicate";
  await appendRow(config.adminsTab, [telegramId, name, nowStamp()]);
  return "ok";
}

export async function removeAdmin(telegramId: string): Promise<boolean> {
  const { admins } = await loadAdmins();
  const admin = admins.find((a) => a.telegramId === telegramId);
  if (!admin) return false;
  await clearRow(config.adminsTab, admin.rowIndex);
  return true;
}
