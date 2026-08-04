import { nowStamp } from "./config";
import { COLLECTIONS, db } from "./mongo";

export interface PhishCatch {
  telegramId: string;
  caughtAt: string;
}

export async function logCatch(telegramId: string): Promise<void> {
  await (await db())
    .collection(COLLECTIONS.phishCatches)
    .insertOne({ telegramId, caughtAt: nowStamp() });
}

export async function loadCatches(): Promise<PhishCatch[]> {
  const docs = await (await db()).collection(COLLECTIONS.phishCatches).find({}).toArray();
  return docs.map((d) => ({
    telegramId: String(d.telegramId ?? ""),
    caughtAt: String(d.caughtAt ?? ""),
  }));
}
