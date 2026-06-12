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
  // Default menu for everyone
  await bot.api.setMyCommands(USER_COMMANDS);

  // Leader menus first (may be overridden by admin/superadmin below)
  const linkedLeaderIds = [
    ...new Set(leaders.filter((l) => l.telegramId).map((l) => Number(l.telegramId))),
  ];
  for (const id of linkedLeaderIds) {
    await setCommandsForUser(bot, id, "leader");
  }

  // Admin menus (override leader if someone is both)
  for (const admin of admins) {
    if (admin.telegramId) {
      await setCommandsForUser(bot, Number(admin.telegramId), "admin");
    }
  }

  // Superadmin menus (override everything)
  for (const id of config.adminIds) {
    await setCommandsForUser(bot, id, "superadmin");
  }
}
