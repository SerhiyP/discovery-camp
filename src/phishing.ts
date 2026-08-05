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

// --- QR-code phishing (anonymous scan count) ---
//
// The QR poster encodes a plain https URL that opens api/phish directly in the
// browser — no Telegram hop, so there is no telegramId and no "who". We only
// count scans. One doc per scan keeps the per-day breakdown trivial.

export interface PhishScan {
  scannedAt: string;
}

export async function logScan(): Promise<void> {
  await (await db()).collection(COLLECTIONS.phishScans).insertOne({ scannedAt: nowStamp() });
}

export async function loadScans(): Promise<PhishScan[]> {
  const docs = await (await db()).collection(COLLECTIONS.phishScans).find({}).toArray();
  return docs.map((d) => ({ scannedAt: String(d.scannedAt ?? "") }));
}
