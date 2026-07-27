import { config, nowStamp } from "./config";
import { appendRow, getRows, headerIndex } from "./sheets";

export interface PhishCatch {
  telegramId: string;
  caughtAt: string;
}

export async function logCatch(telegramId: string): Promise<void> {
  await appendRow(config.phishCatchesTab, [telegramId, nowStamp()]);
}

export async function loadCatches(): Promise<PhishCatch[]> {
  const rows = await getRows(config.phishCatchesTab);
  if (rows.length === 0) return [];
  const header = rows[0];
  const idCol = headerIndex(header, "Telegram ID");
  const atCol = headerIndex(header, "Caught at");
  const catches: PhishCatch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const telegramId = (rows[i][idCol] ?? "").trim();
    if (!telegramId) continue;
    catches.push({ telegramId, caughtAt: (rows[i][atCol] ?? "").trim() });
  }
  return catches;
}
