import { google } from "googleapis";
import { config } from "./config";

const auth = new google.auth.JWT({
  email: config.serviceAccountEmail,
  key: config.privateKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

/**
 * Read coalescing.
 *
 * Google's default Sheets quota is 60 read *requests* per minute per user, and the
 * service account is one "user" shared by the entire camp — so the whole check-in desk
 * draws on a single 60/min bucket. A `values.batchGet` counts as ONE request regardless
 * of how many ranges it carries, so every getRows() issued in the same tick is collected
 * here and sent as a single request. Handlers that fan out with Promise.all (role
 * lookups, the check-in final message) therefore cost one read instead of three or four.
 *
 * Nothing is cached: every call still returns data fetched during that call, so a row
 * written by staff straight into the sheet is visible on the very next interaction.
 */
const MAX_RANGES_PER_REQUEST = 20;

/** Retry a rate-limited read briefly — the quota window is per minute and slides. */
const RETRY_DELAYS_MS = [400, 1200];

interface Waiter {
  resolve: (rows: string[][]) => void;
  reject: (err: unknown) => void;
}

/** spreadsheetId -> tab -> everyone awaiting that tab in the current tick. */
let pending = new Map<string, Map<string, Waiter[]>>();
let flushScheduled = false;

function isRateLimited(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; message?: string };
  const code = Number(e?.code ?? e?.status);
  // Sheets reports quota exhaustion as 429; older responses use 403 + a quota message.
  return code === 429 || (code === 403 && /quota|rate limit/i.test(e?.message ?? ""));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function batchGetWithRetry(spreadsheetId: string, ranges: string[]): Promise<string[][][]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
      const valueRanges = res.data.valueRanges ?? [];
      // The API returns valueRanges in the order the ranges were requested.
      return ranges.map((_, i) => (valueRanges[i]?.values as string[][]) ?? []);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRateLimited(err)) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(async () => {
    flushScheduled = false;
    const batches = pending;
    pending = new Map();

    for (const [spreadsheetId, byTab] of batches) {
      const tabs = [...byTab.keys()];
      for (let i = 0; i < tabs.length; i += MAX_RANGES_PER_REQUEST) {
        const chunk = tabs.slice(i, i + MAX_RANGES_PER_REQUEST);
        try {
          const results = await batchGetWithRetry(
            spreadsheetId,
            chunk.map((tab) => `'${tab}'`),
          );
          chunk.forEach((tab, j) => {
            for (const w of byTab.get(tab)!) w.resolve(results[j]);
          });
        } catch (err) {
          for (const tab of chunk) {
            for (const w of byTab.get(tab)!) w.reject(err);
          }
        }
      }
    }
  });
}

export function getRowsFromSpreadsheet(spreadsheetId: string, tab: string): Promise<string[][]> {
  let byTab = pending.get(spreadsheetId);
  if (!byTab) {
    byTab = new Map();
    pending.set(spreadsheetId, byTab);
  }
  let waiters = byTab.get(tab);
  if (!waiters) {
    waiters = [];
    byTab.set(tab, waiters);
  }
  const result = new Promise<string[][]>((resolve, reject) => {
    waiters!.push({ resolve, reject });
  });
  scheduleFlush();
  return result;
}

export async function getRows(tab: string): Promise<string[][]> {
  return getRowsFromSpreadsheet(config.sheetId, tab);
}

/** Column index (0-based) to A1 letter: 0 -> A, 26 -> AA. */
export function colLetter(index: number): string {
  let letter = "";
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

/** rowIndex is 0-based including the header row (header = 0). */
export async function updateCell(
  tab: string,
  rowIndex: number,
  colIndex: number,
  value: string,
): Promise<void> {
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `'${tab}'!${colLetter(colIndex)}${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

export async function appendRow(tab: string, values: string[]): Promise<void> {
  await appendRows(tab, [values]);
}

/** Appends many rows in one request. Writes have their own 60/minute/user quota, so
 *  bulk operations (/syncresp) must not append in a loop. No-op for an empty list. */
export async function appendRows(tab: string, rows: string[][]): Promise<void> {
  if (rows.length === 0) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `'${tab}'`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

/** Clears all values in a row (rowIndex is 0-based including header). Used for soft-delete. */
export async function clearRow(tab: string, rowIndex: number): Promise<void> {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.sheetId,
    range: `'${tab}'!${rowIndex + 1}:${rowIndex + 1}`,
  });
}

/** Returns the 0-based index of a header, or -1. Trims and compares case-insensitively. */
export function headerIndex(headerRow: string[], header: string): number {
  const target = header.trim().toLowerCase();
  return headerRow.findIndex((h) => (h ?? "").trim().toLowerCase() === target);
}
