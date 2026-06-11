import { google } from "googleapis";
import { config } from "./config";

const auth = new google.auth.JWT({
  email: config.serviceAccountEmail,
  key: config.privateKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

export async function getRows(tab: string): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `'${tab}'`,
  });
  return (res.data.values as string[][]) ?? [];
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
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `'${tab}'`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

/** Returns the 0-based index of a header, or -1. Trims and compares case-insensitively. */
export function headerIndex(headerRow: string[], header: string): number {
  const target = header.trim().toLowerCase();
  return headerRow.findIndex((h) => (h ?? "").trim().toLowerCase() === target);
}
