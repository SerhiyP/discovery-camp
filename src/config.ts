function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  botUsername: process.env.BOT_USERNAME ?? "",
  webhookSecret: process.env.WEBHOOK_SECRET,
  adminIds: (process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(Boolean),

  serviceAccountEmail: required("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
  privateKey: required("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n"),
  sheetId: required("SHEET_ID"),

  responsesTab: process.env.RESPONSES_TAB ?? "Form Responses 1",
  nameHeader: process.env.NAME_HEADER ?? "Прізвище та ім'я",
  checkinHeader: process.env.CHECKIN_HEADER ?? "Checked in",
  telegramIdHeader: process.env.TELEGRAM_ID_HEADER ?? "Telegram ID",
  teamHeader: process.env.TEAM_HEADER ?? "",
  roomHeader: process.env.ROOM_HEADER ?? "Кімната",

  eventsTab: "Events",
  registrationsTab: "EventRegs",
  adminsTab: "Admins",
  leadersTab: "Leaders",
  videosTab: "Videos",

  defaultVideoFileId: process.env.DEFAULT_VIDEO_FILE_ID ?? "",
  timeZone: "Europe/Kyiv",
};

/** Today's date as YYYY-MM-DD in camp's time zone. */
export function todayISO(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: config.timeZone,
  }).format(new Date());
}

/** Timestamp like "2026-06-11 14:05" in camp's time zone. */
export function nowStamp(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: config.timeZone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
}
