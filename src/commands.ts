import { Bot } from "grammy";
import { config } from "./config";
import { Admin } from "./admins";
import { Leader } from "./leaders";

export type UserRole = "user" | "leader" | "admin" | "superadmin";

const USER_COMMANDS = [
  { command: "events", description: "Події на сьогодні" },
  { command: "schedule", description: "Розклад" },
  { command: "myevents", description: "Мої реєстрації" },
];

const LEADER_COMMANDS = [
  ...USER_COMMANDS,
  { command: "notifyteam", description: "Повідомити свою команду" },
  { command: "renameteam", description: "Перейменувати команду" },
];

const ADMIN_COMMANDS = [
  ...LEADER_COMMANDS,
  { command: "addleader", description: "Додати лідера: /addleader Команда Прізвище Імʼя" },
  { command: "removeleader", description: "Видалити лідера: /removeleader Команда Прізвище Імʼя" },
  { command: "listleaders", description: "Список лідерів" },
  { command: "broadcast", description: "Розсилка всім учасникам" },
];

const SUPERADMIN_COMMANDS = [
  ...ADMIN_COMMANDS,
  { command: "addadmin", description: "Додати адміна: /addadmin TelegramID Імʼя" },
  { command: "removeadmin", description: "Видалити адміна: /removeadmin TelegramID" },
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
