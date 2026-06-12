# Discovery Camp Bot — Enhanced Roles & UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a three-tier role system (superadmin/admin/leader), scoped command menus per role, leader self-check-in, team management commands, and a name-search UX fix.

**Architecture:** Roles are checked per-request against Google Sheets (Admins and Leaders tabs) — consistent with how visitors are already loaded. Three new modules (`admins.ts`, `leaders.ts`, `commands.ts`) handle sheet access and menu logic. All handlers live in `bot.ts`. No sessions needed; all flows are stateless.

**Tech Stack:** TypeScript, grammY 1.x, Google Sheets API v4, Vercel serverless

---

## Prerequisites (manual setup before running the code)

Create two new tabs in the Google Spreadsheet (same spreadsheet as `SHEET_ID`):

**`Admins`** tab — row 1 must be the header:
```
Telegram ID | Name | Added at
```

**`Leaders`** tab — row 1 must be the header:
```
Team | Name | Telegram ID | Added at
```

Leave both tabs with only the header row. The bot will append rows as admins and leaders are added.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/config.ts` | Modify | Add `adminsTab`, `leadersTab` constants |
| `src/sheets.ts` | Modify | Add `clearRow` helper |
| `src/admins.ts` | Create | Admin CRUD against Admins sheet tab |
| `src/leaders.ts` | Create | Leader CRUD, name search, team rename |
| `src/checkin.ts` | Modify | Add `updateTeamVideo`, `renameVisitorTeams`, `renameTeamVideo` |
| `src/commands.ts` | Create | `setCommandsForUser`, `initCommandMenus` |
| `src/messages.ts` | Modify | Add all new Ukrainian strings; update 2 existing |
| `src/bot.ts` | Modify | Add all new command/callback handlers |

---

## Task 1: Add tab name constants to config.ts

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add two tab constants**

In `src/config.ts`, add inside the `config` object after `registrationsTab: "EventRegs",`:

```typescript
  adminsTab: "Admins",
  leadersTab: "Leaders",
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add Admins and Leaders tab names to config"
```

---

## Task 2: Add clearRow to sheets.ts

**Files:**
- Modify: `src/sheets.ts`

`clearRow` is needed by `removeAdmin` and `removeLeader` to soft-delete rows (clears all values in a row so loaders skip it).

- [ ] **Step 1: Add clearRow after the appendRow function**

In `src/sheets.ts`, add after `appendRow`:

```typescript
/** Clears all values in a row (rowIndex is 0-based including header). Used for soft-delete. */
export async function clearRow(tab: string, rowIndex: number): Promise<void> {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.sheetId,
    range: `'${tab}'!${rowIndex + 1}:${rowIndex + 1}`,
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/sheets.ts
git commit -m "feat: add clearRow helper to sheets.ts"
```

---

## Task 3: Create src/admins.ts

**Files:**
- Create: `src/admins.ts`

Manages the `Admins` sheet tab (`Telegram ID | Name | Added at`).

- [ ] **Step 1: Create the file**

```typescript
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
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/admins.ts
git commit -m "feat: add admins.ts for admin CRUD against Admins sheet tab"
```

---

## Task 4: Create src/leaders.ts

**Files:**
- Create: `src/leaders.ts`

Manages the `Leaders` sheet tab (`Team | Name | Telegram ID | Added at`). Up to 3 leaders per team.

- [ ] **Step 1: Create the file**

```typescript
import { config, nowStamp } from "./config";
import { appendRow, clearRow, getRows, headerIndex, updateCell } from "./sheets";

export interface Leader {
  rowIndex: number;
  team: string;
  name: string;
  telegramId: string;
  addedAt: string;
}

export interface LeaderSheet {
  leaders: Leader[];
  cols: { team: number; name: number; telegramId: number; addedAt: number };
}

export async function loadLeaders(): Promise<LeaderSheet> {
  const rows = await getRows(config.leadersTab);
  if (rows.length === 0) {
    return { leaders: [], cols: { team: 0, name: 1, telegramId: 2, addedAt: 3 } };
  }
  const header = rows[0];
  const cols = {
    team: headerIndex(header, "Team"),
    name: headerIndex(header, "Name"),
    telegramId: headerIndex(header, "Telegram ID"),
    addedAt: headerIndex(header, "Added at"),
  };
  const leaders: Leader[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const team = (row[cols.team] ?? "").trim();
    const name = (row[cols.name] ?? "").trim();
    if (!team && !name) continue; // cleared row
    leaders.push({
      rowIndex: i,
      team,
      name,
      telegramId: (row[cols.telegramId] ?? "").trim(),
      addedAt: (row[cols.addedAt] ?? "").trim(),
    });
  }
  return { leaders, cols };
}

export function findLeadersByTelegramId(leaders: Leader[], telegramId: number): Leader[] {
  return leaders.filter((l) => l.telegramId === String(telegramId));
}

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[''ʼ`]/g, "").replace(/\s+/g, " ").trim();
}

/** Returns unlinked leaders matching the query (same prefix-match logic as visitor search). */
export function searchLeaderByName(leaders: Leader[], query: string): Leader[] {
  const q = normalizeStr(query);
  if (!q) return [];
  const qTokens = q.split(" ");
  return leaders
    .filter((l) => !l.telegramId)
    .filter((l) => {
      const nTokens = normalizeStr(l.name).split(" ");
      return qTokens.every((qt) => nTokens.some((nt) => nt.startsWith(qt)));
    });
}

export async function setLeaderTelegramId(
  sheet: LeaderSheet,
  rowIndex: number,
  telegramId: number,
): Promise<void> {
  await updateCell(config.leadersTab, rowIndex, sheet.cols.telegramId, String(telegramId));
}

export async function addLeader(team: string, name: string): Promise<"ok" | "full" | "duplicate"> {
  const { leaders } = await loadLeaders();
  const teamLeaders = leaders.filter((l) => l.team.toLowerCase() === team.toLowerCase());
  if (teamLeaders.length >= 3) return "full";
  if (teamLeaders.some((l) => l.name.toLowerCase() === name.toLowerCase())) return "duplicate";
  await appendRow(config.leadersTab, [team, name, "", nowStamp()]);
  return "ok";
}

export async function removeLeader(team: string, name: string): Promise<boolean> {
  const { leaders } = await loadLeaders();
  const leader = leaders.find(
    (l) =>
      l.team.toLowerCase() === team.toLowerCase() &&
      l.name.toLowerCase() === name.toLowerCase(),
  );
  if (!leader) return false;
  await clearRow(config.leadersTab, leader.rowIndex);
  return true;
}

/** Updates Team column in Leaders tab for all rows matching oldName. Returns count updated. */
export async function renameLeaderTeams(oldName: string, newName: string): Promise<number> {
  const { leaders, cols } = await loadLeaders();
  let count = 0;
  for (const l of leaders) {
    if (l.team.toLowerCase() === oldName.toLowerCase()) {
      await updateCell(config.leadersTab, l.rowIndex, cols.team, newName);
      count++;
    }
  }
  return count;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/leaders.ts
git commit -m "feat: add leaders.ts for leader CRUD, name search, and team rename"
```

---

## Task 5: Add video and rename helpers to checkin.ts

**Files:**
- Modify: `src/checkin.ts`

Three new exported functions used by leader commands.

- [ ] **Step 1: Add appendRow to the existing import from sheets**

In `src/checkin.ts`, the current import is:
```typescript
import { getRows, headerIndex, updateCell } from "./sheets";
```
Replace with:
```typescript
import { appendRow, getRows, headerIndex, updateCell } from "./sheets";
```

- [ ] **Step 2: Add the three functions at the bottom of checkin.ts**

```typescript
/** Updates or inserts a team's video file_id in the Videos tab. */
export async function updateTeamVideo(team: string, fileId: string): Promise<void> {
  const rows = await getRows(config.videosTab);
  const target = team.trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] ?? "").trim().toLowerCase() === target) {
      await updateCell(config.videosTab, i, 1, fileId);
      return;
    }
  }
  await appendRow(config.videosTab, [team, fileId]);
}

/** Bulk-updates the team column in the responses sheet for all visitors on oldName. Returns count updated. */
export async function renameVisitorTeams(oldName: string, newName: string): Promise<number> {
  const sheet = await loadVisitors();
  if (sheet.cols.team < 0) return 0;
  let count = 0;
  for (const v of sheet.visitors) {
    if (v.team.toLowerCase() === oldName.toLowerCase()) {
      await updateCell(config.responsesTab, v.rowIndex, sheet.cols.team, newName);
      count++;
    }
  }
  return count;
}

/** Updates the team name in the Videos tab when a team is renamed. */
export async function renameTeamVideo(oldName: string, newName: string): Promise<void> {
  const rows = await getRows(config.videosTab);
  const target = oldName.trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] ?? "").trim().toLowerCase() === target) {
      await updateCell(config.videosTab, i, 0, newName);
      return;
    }
  }
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/checkin.ts
git commit -m "feat: add updateTeamVideo, renameVisitorTeams, renameTeamVideo to checkin.ts"
```

---

## Task 6: Create src/commands.ts

**Files:**
- Create: `src/commands.ts`

Sets scoped per-user command menus via `setMyCommands`.

- [ ] **Step 1: Create the file**

```typescript
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
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/commands.ts
git commit -m "feat: add commands.ts for scoped Telegram command menus per role"
```

---

## Task 7: Update messages.ts

**Files:**
- Modify: `src/messages.ts`

Update two existing strings (name search UX fix) and add all new strings.

- [ ] **Step 1: Replace the entire file**

```typescript
export const M = {
  welcome:
    "Вітаємо в Discovery Camp! 🏕\n\nЩоб відмітитись на реєстрації, напишіть своє прізвище та ім'я — так, як ви вказували їх у формі реєстрації.",
  alreadyLinked: (name: string) =>
    `Ви вже відмічені як ${name} ✅\n\nКоманди:\n/events — події на сьогодні\n/schedule — розклад\n/myevents — мої реєстрації`,
  askName: "Напишіть своє прізвище та ім'я — так, як у формі реєстрації.",
  chooseYourself: "Знайшли кілька збігів. Натисніть на своє ім'я 👇",
  confirmOne: "Це ви? Натисніть, щоб підтвердитись 👇",
  notFound:
    "Не знайшли вас у списку 😔 Спробуйте написати ім'я інакше (наприклад, лише прізвище) або зверніться до організаторів на вході.",
  rowTaken:
    "Цей учасник уже відмітився з іншого акаунта. Якщо це помилка — зверніться до організаторів.",
  checkedIn: (name: string) => `Готово, ${name}! Ви відмічені ✅\nГарного табору! 🎉`,
  videoCaption: "Відеопривітання від вашого лідера команди 🎬",
  noEventsToday: "На сьогодні подій немає.",
  eventsToday: "Події на сьогодні:",
  scheduleTitle: "Розклад подій:",
  registered: (title: string) => `Ви зареєстровані на «${title}» ✅`,
  unregistered: (title: string) => `Реєстрацію на «${title}» скасовано.`,
  eventFull: "На жаль, місць більше немає 😔",
  alreadyRegistered: "Ви вже зареєстровані на цю подію.",
  myEventsTitle: "Ваші реєстрації:",
  myEventsEmpty: "Ви поки не зареєстровані на жодну подію. Подивіться /events",
  mustCheckInFirst: "Спершу відмітьтесь: напишіть своє прізвище та ім'я.",
  morningDigest: "Доброго ранку! ☀️ Сьогодні в таборі:",
  registerButton: "Зареєструватися",
  unregisterButton: "Скасувати реєстрацію",
  spotsLeft: (n: number) => `вільних місць: ${n}`,

  // /myid
  yourId: (id: number) => `Ваш Telegram ID: <code>${id}</code>`,

  // Leader check-in
  leaderPrompt:
    "Це вхід для лідерів команд. Напишіть своє прізвище та ім'я — так, як вас зареєстрував адміністратор.",
  leaderAlreadyLinked: (name: string, team: string) =>
    `Ви вже підключені як лідер команди «${team}» (${name}) ✅`,
  confirmLeader: (name: string, team: string) =>
    `Це ви — лідер команди «${team}»?\n${name}\n\nНатисніть, щоб підтвердитись 👇`,
  chooseLeader: "Знайшли кілька збігів серед лідерів. Натисніть на своє ім'я 👇",
  leaderCheckedIn: (name: string, team: string) =>
    `Готово, ${name}! Ви підключені як лідер команди «${team}» ✅`,
  leaderNotFound:
    "Не знайшли вас у списку лідерів 😔 Зверніться до адміністратора.",

  // Leader commands
  notifyTeamNoText: "Використання: /notifyteam <текст повідомлення>",
  notifyTeamEmpty: "У вашій команді ще ніхто не підключився до бота.",
  notifyTeamSent: (count: number, teams: string) =>
    `Надіслано ${count} учасникам команд: ${teams} ✅`,
  renameTeamNoText: "Використання: /renameteam <нова назва>",
  renameTeamDone: (oldName: string, newName: string, count: number) =>
    `Команду «${oldName}» перейменовано на «${newName}» ✅ Оновлено ${count} учасників.`,
  chooseTeamToRename: (newName: string) => `Яку команду перейменувати на «${newName}»?`,
  videoUpdated: (team: string) => `Відео для команди «${team}» оновлено ✅`,
  videoMultiTeamHint: (teams: string) =>
    `Для якої команди це відео?\nВаші команди: ${teams}\n\nДодайте назву команди як підпис до відео і надішліть ще раз.`,

  // Admin commands
  addLeaderUsage: "Використання: /addleader <Команда> <Прізвище та ім'я>",
  leaderAdded: (name: string, team: string) => `Лідера ${name} додано до команди «${team}» ✅`,
  leaderAddedFull: (team: string) =>
    `У команди «${team}» вже 3 лідери — більше додати не можна.`,
  leaderAddedDuplicate: (name: string, team: string) =>
    `${name} вже є лідером команди «${team}».`,
  removeLeaderUsage: "Використання: /removeleader <Команда> <Прізвище та ім'я>",
  leaderRemoved: (name: string, team: string) =>
    `Лідера ${name} видалено з команди «${team}» ✅`,
  leaderNotFoundAdmin: (name: string, team: string) =>
    `Лідера ${name} у команді «${team}» не знайдено.`,
  noLeaders: "Лідерів ще немає.",
  leadersListTitle: "Список лідерів:",
  leaderListLine: (team: string, name: string, linked: boolean) =>
    `• [${team}] ${name}${linked ? " ✅" : " (не підключений)"}`,

  // Superadmin commands
  notSuperAdmin: "Ця команда доступна лише суперадміну.",
  notAdmin: "Ця команда доступна лише адміністраторам.",
  notLeader: "Ця команда доступна лише лідерам команд.",
  addAdminUsage: "Використання: /addadmin <TelegramID> <Ім'я>",
  adminAdded: (name: string, id: string) => `Адміна ${name} (${id}) додано ✅`,
  adminAddedDuplicate: (id: string) => `Адмін з ID ${id} вже існує.`,
  removeAdminUsage: "Використання: /removeadmin <TelegramID>",
  adminRemoved: (id: string) => `Адміна ${id} видалено ✅`,
  adminNotFound: (id: string) => `Адміна з ID ${id} не знайдено.`,
  noAdmins: "Адмінів ще немає.",
  adminsListTitle: "Список адмінів:",
  adminListLine: (name: string, id: string) => `• ${name} (${id})`,
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/messages.ts
git commit -m "feat: update name-search prompts and add all new role/command strings"
```

---

## Task 8: Refactor isAdmin + add /myid and /leader in bot.ts

**Files:**
- Modify: `src/bot.ts`

Replace the synchronous `isAdmin` helper (env-var-only check) with `isSuperAdmin`. Import async-aware `isAdmin` from `admins.ts`. Add `/myid` and `/leader` commands.

- [ ] **Step 1: Replace the import block at the top of bot.ts**

Replace everything from `import { Bot` through `import { M }` with:

```typescript
import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config";
import {
  findByTelegramId,
  linkAndCheckIn,
  loadVisitors,
  renameTeamVideo,
  renameVisitorTeams,
  searchByName,
  updateTeamVideo,
  videoForTeam,
} from "./checkin";
import {
  activeRegs,
  loadEvents,
  loadRegistrations,
  register,
  todayEvents,
  unregister,
  upcomingEvents,
} from "./events";
import { M } from "./messages";
import { addAdmin, isAdmin, loadAdmins, removeAdmin } from "./admins";
import {
  addLeader,
  findLeadersByTelegramId,
  loadLeaders,
  removeLeader,
  renameLeaderTeams,
  searchLeaderByName,
  setLeaderTelegramId,
} from "./leaders";
import { initCommandMenus, setCommandsForUser } from "./commands";
```

- [ ] **Step 2: Rename the isAdmin helper to isSuperAdmin**

Replace:
```typescript
const isAdmin = (id?: number) => !!id && config.adminIds.includes(id);
```
With:
```typescript
const isSuperAdmin = (id?: number) => !!id && config.adminIds.includes(id);
```

- [ ] **Step 3: Update /broadcast to use async isAdmin**

Find the broadcast handler and replace its guard:
```typescript
bot.command("broadcast", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
```
With:
```typescript
bot.command("broadcast", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return;
```

- [ ] **Step 4: Update message:video to use isSuperAdmin temporarily**

In the `bot.on("message:video", ...)` handler, replace `if (!isAdmin(ctx.from?.id))` with `if (!isSuperAdmin(ctx.from?.id))`. (This handler is fully rewritten in Task 14.)

- [ ] **Step 5: Add /myid and /leader after the /start handler**

After the `bot.command("start", ...)` block, insert:

```typescript
bot.command("myid", async (ctx) => {
  await ctx.reply(M.yourId(ctx.from!.id), { parse_mode: "HTML" });
});

bot.command("leader", async (ctx) => {
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length > 0) {
    return ctx.reply(M.leaderAlreadyLinked(mine[0].name, mine[0].team));
  }
  return ctx.reply(M.leaderPrompt);
});
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/bot.ts
git commit -m "feat: add /myid, /leader; refactor isAdmin to isSuperAdmin in bot.ts"
```

---

## Task 9: Extend text handler to search leaders

**Files:**
- Modify: `src/bot.ts`

The existing `message:text` handler searches only visitors. Extend it to also search the Leaders tab so unlinked leaders can find themselves.

- [ ] **Step 1: Replace the entire message:text handler**

Find and replace the entire `bot.on("message:text", async (ctx) => { ... });` block with:

```typescript
bot.on("message:text", async (ctx) => {
  const [sheet, leaderSheet] = await Promise.all([loadVisitors(), loadLeaders()]);

  const meVisitor = findByTelegramId(sheet.visitors, ctx.from.id);
  if (meVisitor) return ctx.reply(M.alreadyLinked(meVisitor.name));

  const meLeader = findLeadersByTelegramId(leaderSheet.leaders, ctx.from.id);
  if (meLeader.length > 0) {
    return ctx.reply(M.leaderAlreadyLinked(meLeader[0].name, meLeader[0].team));
  }

  const visitorMatches = searchByName(sheet.visitors, ctx.message.text);
  const leaderMatches = searchLeaderByName(leaderSheet.leaders, ctx.message.text);

  if (visitorMatches.length === 0 && leaderMatches.length === 0) {
    return ctx.reply(M.notFound);
  }

  const kb = new InlineKeyboard();

  if (visitorMatches.length === 1 && leaderMatches.length === 0) {
    kb.text(visitorMatches[0].name, `link:${visitorMatches[0].rowIndex}`).row();
    return ctx.reply(M.confirmOne, { reply_markup: kb });
  }

  if (leaderMatches.length === 1 && visitorMatches.length === 0) {
    const l = leaderMatches[0];
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
    return ctx.reply(M.confirmLeader(l.name, l.team), { reply_markup: kb });
  }

  for (const v of visitorMatches) kb.text(v.name, `link:${v.rowIndex}`).row();
  for (const l of leaderMatches)
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();

  return ctx.reply(M.chooseYourself, { reply_markup: kb });
});
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat: extend text handler to search Leaders tab alongside visitors"
```

---

## Task 10: Add link_leader callback

**Files:**
- Modify: `src/bot.ts`

Handles the leader check-in button tap: links Telegram ID in the Leaders tab and sets their command menu.

- [ ] **Step 1: Add callback handler after the existing link:rowIndex callback**

After the `bot.callbackQuery(/^link:(\d+)$/, ...)` block, insert:

```typescript
bot.callbackQuery(/^link_leader:(\d+)$/, async (ctx) => {
  const rowIndex = Number(ctx.match[1]);
  const leaderSheet = await loadLeaders();

  const alreadyLinked = findLeadersByTelegramId(leaderSheet.leaders, ctx.from.id);
  if (alreadyLinked.length > 0) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.leaderAlreadyLinked(alreadyLinked[0].name, alreadyLinked[0].team));
  }

  const leader = leaderSheet.leaders.find((l) => l.rowIndex === rowIndex);
  if (!leader) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.leaderNotFound);
  }
  if (leader.telegramId && leader.telegramId !== String(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.rowTaken);
  }

  await setLeaderTelegramId(leaderSheet, rowIndex, ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(M.leaderCheckedIn(leader.name, leader.team));

  const { admins } = await loadAdmins();
  const role = isSuperAdmin(ctx.from.id)
    ? "superadmin"
    : isAdmin(ctx.from.id, admins)
    ? "admin"
    : "leader";
  await setCommandsForUser(bot, ctx.from.id, role);
});
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat: add link_leader callback for leader check-in"
```

---

## Task 11: Add admin commands

**Files:**
- Modify: `src/bot.ts`

Three admin commands: `/addleader`, `/removeleader`, `/listleaders`. Parsing: first word = team, everything after = name.

- [ ] **Step 1: Add admin commands block after the /broadcast handler**

```typescript
// --- admin commands ---

bot.command("addleader", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.addLeaderUsage);
  const [team, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const result = await addLeader(team, name);
  if (result === "full") return ctx.reply(M.leaderAddedFull(team));
  if (result === "duplicate") return ctx.reply(M.leaderAddedDuplicate(name, team));
  return ctx.reply(M.leaderAdded(name, team));
});

bot.command("removeleader", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.removeLeaderUsage);
  const [team, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const ok = await removeLeader(team, name);
  if (!ok) return ctx.reply(M.leaderNotFoundAdmin(name, team));
  return ctx.reply(M.leaderRemoved(name, team));
});

bot.command("listleaders", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const { leaders } = await loadLeaders();
  if (leaders.length === 0) return ctx.reply(M.noLeaders);
  const lines = [M.leadersListTitle, ""];
  for (const l of leaders) lines.push(M.leaderListLine(l.team, l.name, !!l.telegramId));
  return ctx.reply(lines.join("\n"));
});
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat: add /addleader, /removeleader, /listleaders admin commands"
```

---

## Task 12: Add superadmin commands

**Files:**
- Modify: `src/bot.ts`

Three superadmin commands: `/addadmin`, `/removeadmin`, `/listadmins`.

- [ ] **Step 1: Add superadmin commands block after the admin commands**

```typescript
// --- superadmin commands ---

bot.command("addadmin", async (ctx) => {
  if (!isSuperAdmin(ctx.from?.id)) return ctx.reply(M.notSuperAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.addAdminUsage);
  const [telegramId, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const result = await addAdmin(telegramId, name);
  if (result === "duplicate") return ctx.reply(M.adminAddedDuplicate(telegramId));
  await ctx.reply(M.adminAdded(name, telegramId));
  const numId = Number(telegramId);
  if (numId) await setCommandsForUser(bot, numId, "admin");
});

bot.command("removeadmin", async (ctx) => {
  if (!isSuperAdmin(ctx.from?.id)) return ctx.reply(M.notSuperAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (!parts[0]) return ctx.reply(M.removeAdminUsage);
  const telegramId = parts[0];
  const ok = await removeAdmin(telegramId);
  if (!ok) return ctx.reply(M.adminNotFound(telegramId));
  await ctx.reply(M.adminRemoved(telegramId));
  const numId = Number(telegramId);
  if (numId) {
    const { leaders } = await loadLeaders();
    const stillLeader = findLeadersByTelegramId(leaders, numId).length > 0;
    await setCommandsForUser(bot, numId, stillLeader ? "leader" : "user");
  }
});

bot.command("listadmins", async (ctx) => {
  if (!isSuperAdmin(ctx.from?.id)) return ctx.reply(M.notSuperAdmin);
  const { admins } = await loadAdmins();
  if (admins.length === 0) return ctx.reply(M.noAdmins);
  const lines = [M.adminsListTitle, ""];
  for (const a of admins) lines.push(M.adminListLine(a.name, a.telegramId));
  return ctx.reply(lines.join("\n"));
});
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat: add /addadmin, /removeadmin, /listadmins superadmin commands"
```

---

## Task 13: Add leader commands (/notifyteam and /renameteam)

**Files:**
- Modify: `src/bot.ts`

`/notifyteam` sends to all members of all the leader's teams. `/renameteam` renames one team; if leader has multiple, shows a keyboard to choose which.

- [ ] **Step 1: Add leader commands block after the superadmin commands**

```typescript
// --- leader commands ---

bot.command("notifyteam", async (ctx) => {
  const text = ctx.match.trim();
  if (!text) return ctx.reply(M.notifyTeamNoText);
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length === 0) return ctx.reply(M.notLeader);
  const myTeams = [...new Set(mine.map((l) => l.team))];
  const { visitors } = await loadVisitors();
  const members = visitors.filter(
    (v) => v.telegramId && myTeams.some((t) => t.toLowerCase() === v.team.toLowerCase()),
  );
  if (members.length === 0) return ctx.reply(M.notifyTeamEmpty);
  const ids = [...new Set(members.map((v) => v.telegramId))];
  let sent = 0;
  for (const id of ids) {
    try {
      await bot.api.sendMessage(id, text);
      sent++;
    } catch {
      // user blocked the bot or never started it
    }
  }
  return ctx.reply(M.notifyTeamSent(sent, myTeams.join(", ")));
});

bot.command("renameteam", async (ctx) => {
  const newName = ctx.match.trim();
  if (!newName) return ctx.reply(M.renameTeamNoText);
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length === 0) return ctx.reply(M.notLeader);
  const myTeams = [...new Set(mine.map((l) => l.team))];
  if (myTeams.length === 1) {
    const oldTeam = myTeams[0];
    const [visitorsCount] = await Promise.all([
      renameVisitorTeams(oldTeam, newName),
      renameLeaderTeams(oldTeam, newName),
      renameTeamVideo(oldTeam, newName),
    ]);
    return ctx.reply(M.renameTeamDone(oldTeam, newName, visitorsCount));
  }
  const kb = new InlineKeyboard();
  for (const t of myTeams) kb.text(t, `renameteam:${t}:${newName}`).row();
  return ctx.reply(M.chooseTeamToRename(newName), { reply_markup: kb });
});

bot.callbackQuery(/^renameteam:([^:]+):(.+)$/, async (ctx) => {
  const oldTeam = ctx.match[1];
  const newName = ctx.match[2];
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from.id);
  const ownsTeam = mine.some((l) => l.team === oldTeam);
  await ctx.answerCallbackQuery();
  if (!ownsTeam) return ctx.editMessageText(M.notLeader);
  const [visitorsCount] = await Promise.all([
    renameVisitorTeams(oldTeam, newName),
    renameLeaderTeams(oldTeam, newName),
    renameTeamVideo(oldTeam, newName),
  ]);
  return ctx.editMessageText(M.renameTeamDone(oldTeam, newName, visitorsCount));
});
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat: add /notifyteam and /renameteam leader commands"
```

---

## Task 14: Rewrite video handler for leaders

**Files:**
- Modify: `src/bot.ts`

Replace the current video handler. Admins still get `file_id` echoed. Leaders update their team's video — if they lead multiple teams, they resend the video with the team name as the caption.

- [ ] **Step 1: Replace the entire message:video handler**

Find and replace the entire `bot.on("message:video", async (ctx) => { ... });` block with:

```typescript
bot.on("message:video", async (ctx) => {
  const fileId = ctx.message.video.file_id;
  const { admins } = await loadAdmins();

  if (isAdmin(ctx.from?.id, admins)) {
    return ctx.reply(`file_id:\n<code>${fileId}</code>`, { parse_mode: "HTML" });
  }

  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length === 0) return;

  const myTeams = [...new Set(mine.map((l) => l.team))];

  if (myTeams.length === 1) {
    await updateTeamVideo(myTeams[0], fileId);
    return ctx.reply(M.videoUpdated(myTeams[0]));
  }

  const caption = (ctx.message.caption ?? "").trim();
  const matched = myTeams.find((t) => t.toLowerCase() === caption.toLowerCase());
  if (matched) {
    await updateTeamVideo(matched, fileId);
    return ctx.reply(M.videoUpdated(matched));
  }

  return ctx.reply(M.videoMultiTeamHint(myTeams.join(", ")));
});
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat: rewrite video handler to support leader team video uploads"
```

---

## Task 15: Initialize command menus at startup

**Files:**
- Modify: `src/bot.ts`

On cold start, set scoped command menus for all known admins and linked leaders.

- [ ] **Step 1: Add startup initialization at the very bottom of bot.ts**

After all handler registrations, append:

```typescript
// Set scoped command menus for all known privileged users on cold start.
(async () => {
  try {
    const [{ admins }, { leaders }] = await Promise.all([loadAdmins(), loadLeaders()]);
    await initCommandMenus(bot, admins, leaders);
  } catch {
    // Non-fatal: menus fall back to defaults if sheets are temporarily unavailable.
  }
})();
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Final commit**

```bash
git add src/bot.ts
git commit -m "feat: initialize scoped command menus for privileged users at startup"
```

---

## Done

Deploy with `npx vercel --prod`, then run `npm run set-webhook` if the URL changed.

**Manual smoke test checklist:**
- [ ] Regular user: `/start` → type name → tap name button → check-in confirmation
- [ ] Regular user: `/events`, `/schedule`, `/myevents` work; menu shows 3 commands
- [ ] Any user: `/myid` returns their Telegram ID
- [ ] Admin adds leader: `/addleader Alpha Іван Петренко`
- [ ] Leader: `/leader` → type name → tap button → confirmation; menu updates to leader commands
- [ ] Leader: `/notifyteam Привіт команда!` → members receive message
- [ ] Leader: `/renameteam NewAlpha` → team renamed in sheet + visitors updated
- [ ] Superadmin: `/addadmin 123456 Оля` → Oля's menu updates to admin commands
- [ ] Superadmin: `/listadmins`, `/listleaders` show correct data
- [ ] Leader sends video → Videos tab updated
