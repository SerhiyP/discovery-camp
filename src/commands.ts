import { Bot } from "grammy";
import { config } from "./config";
import { Admin } from "./admins";
import { Leader } from "./leaders";

export type UserRole = "user" | "leader" | "admin" | "superadmin";

// Only zero-arg commands belong in the slash menu. Tapping a menu entry sends
// it instantly with no arguments, so arg-taking commands (addleader, broadcast,
// notifyteam, renameteam, …) are intentionally omitted — they must be typed by
// hand. Leaders reach notifyteam/renameteam via the reply-keyboard buttons.
const USER_COMMANDS = [
  { command: "help", description: "Що вміє бот" },
  { command: "mc", description: "Майстер-класи сьогодні" },
  { command: "schedule", description: "Розклад" },
  { command: "myevents", description: "Мої реєстрації" },
];

const LEADER_COMMANDS = [...USER_COMMANDS];

const ADMIN_COMMANDS = [
  ...LEADER_COMMANDS,
  { command: "listleaders", description: "Список лідерів" },
  { command: "syncresp", description: "Синхронізувати відповідальних" },
  { command: "delresp", description: "Видалити відповідального" },
  { command: "stats", description: "Статистика табору" },
];

const SUPERADMIN_COMMANDS = [
  ...ADMIN_COMMANDS,
  { command: "listadmins", description: "Список адмінів" },
];

function commandsForRole(role: UserRole) {
  if (role === "superadmin") return SUPERADMIN_COMMANDS;
  if (role === "admin") return ADMIN_COMMANDS;
  if (role === "leader") return LEADER_COMMANDS;
  return USER_COMMANDS;
}

export async function setCommandsForUser(bot: Bot, userId: number, role: UserRole): Promise<void> {
  await bot.api.setMyCommands(commandsForRole(role), {
    scope: { type: "chat", chat_id: userId },
  });
}

/** Called at bot startup to set menus for all known privileged users. */
export async function initCommandMenus(bot: Bot, admins: Admin[], leaders: Leader[]): Promise<void> {
  // No default menu — visitors use the reply keyboard instead
  await bot.api.setMyCommands([]);

  // Build highest-role map so each user gets exactly one API call.
  // Order matters: later writes win (leader < admin < superadmin).
  const roleMap = new Map<number, UserRole>();
  for (const l of leaders) {
    if (l.telegramId) roleMap.set(Number(l.telegramId), "leader");
  }
  for (const a of admins) {
    if (a.telegramId) roleMap.set(Number(a.telegramId), "admin");
  }
  for (const id of config.adminIds) {
    roleMap.set(id, "superadmin");
  }

  await Promise.all(
    [...roleMap.entries()].map(([id, role]) => setCommandsForUser(bot, id, role)),
  );
}
