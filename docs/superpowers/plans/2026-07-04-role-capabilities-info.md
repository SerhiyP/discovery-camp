# Role Capabilities Info — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a short "what this bot does" blurb before registration, a short role-specific capability message right after registration (visitor/leader/responsible), and a `/help` command that recalls the same info later.

**Architecture:** All new copy lives in `src/messages.ts` as plain strings plus one small composing function (`roleCapabilitiesText`). `src/bot.ts` gains a shared `getUserRoles()` helper (replacing inline role-detection duplicated in `keyboardForUser`), used both to build the post-registration follow-up message and to power `/help`. `src/commands.ts` gets `/help` added to the zero-arg command menu.

**Tech Stack:** TypeScript, grammY 1.x, Vercel serverless. No test framework or local dev server exists in this repo — verification is `npm run typecheck` per task plus one end-to-end manual pass after deploy (matches the existing convention, see prior plans in `docs/superpowers/plans/`).

## Global Constraints

- All user-facing strings are Ukrainian, added to the single `M` object in `src/messages.ts` (per `CLAUDE.md`'s module table).
- No automated tests exist in this repo; each task's gate is `npm run typecheck` passing with no errors.
- Reuse existing message/button naming conventions (emoji-prefixed labels matching `src/keyboards.ts`'s `BTN`).
- Don't touch the admin/superadmin command menus or their sheets — out of scope per the design doc.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/messages.ts` | Modify | Add `GENERAL_INFO`, `M.generalInfo`, updated `M.welcome`, `M.capabilitiesBase/Leader/Responsible`, exported `roleCapabilitiesText()` |
| `src/bot.ts` | Modify | Add `getUserRoles()`, refactor `keyboardForUser()` to use it, send capability follow-up after each of the 3 link handlers, add `/help` command |
| `src/commands.ts` | Modify | Add `/help` to `USER_COMMANDS` |

---

## Task 1: Add capability copy to messages.ts

**Files:**
- Modify: `src/messages.ts`

**Interfaces:**
- Produces: `M.generalInfo: string`, `M.welcome: string` (updated), `M.capabilitiesBase: string`, `M.capabilitiesLeader: string`, `M.capabilitiesResponsible: string`, `roleCapabilitiesText(roles: { isLeader?: boolean; isResponsible?: boolean }): string` (named export from `src/messages.ts`). Param names match `getUserRoles`'s return shape (Task 2) so callers in Tasks 3-4 can pass the roles object straight through with no field-mapping at each call site.

- [ ] **Step 1: Add `GENERAL_INFO` const and update `welcome`/add `generalInfo`**

In `src/messages.ts`, replace lines 1-3:

```ts
export const M = {
  welcome:
    "Вітаємо в Discovery Camp! 🏕\n\nЩоб відмітитись на реєстрації, напишіть своє прізвище та ім'я — так, як ви вказували їх у формі реєстрації.",
```

with:

```ts
const GENERAL_INFO =
  "Тут можна:\n" +
  "🎨 реєструватись на майстер-класи\n" +
  "🗓 дивитись розклад табору\n" +
  "📋 бачити свої реєстрації";

export const M = {
  generalInfo: GENERAL_INFO,
  welcome:
    "Вітаємо в Discovery Camp! 🏕\n\n" +
    `${GENERAL_INFO}\n\n` +
    "Щоб почати, відмітьтесь на реєстрації — напишіть своє прізвище та ім'я, так, як ви вказували їх у формі реєстрації.",
```

- [ ] **Step 2: Add capability blocks after `mustCheckInFirst`**

In `src/messages.ts`, find this existing line (currently line 33):

```ts
  mustCheckInFirst: "Спершу відмітьтесь: напишіть своє прізвище та ім'я.",
```

Add immediately after it:

```ts

  // Role capabilities info (post-registration + /help)
  capabilitiesBase:
    "Ось що вам доступно:\n" +
    "🎨 Майстер-класи — реєстрація на майстер-класи\n" +
    "🗓 Розклад — розклад табору на сьогодні\n" +
    "📋 Мої реєстрації — ваші записи на майстер-класи",
  capabilitiesLeader:
    "👑 Як лідер команди:\n" +
    "📢 Сповістити команду — надіслати повідомлення своїй команді\n" +
    "✏️ Перейменувати команду — змінити назву команди",
  capabilitiesResponsible:
    "🎨 Як відповідальний за майстер-клас:\n" +
    "👥 Учасники МК — список учасників вашого майстер-класу\n" +
    "📣 Сповістити учасників МК — надіслати їм повідомлення",
```

- [ ] **Step 3: Add `roleCapabilitiesText` after the `M` object closes**

At the end of `src/messages.ts`, after the closing `};` of `export const M = { ... }`, add:

```ts

/** Composes the post-registration / `/help` capability message from a person's full
 *  current role set — mirrors how `roleKeyboard()` composes the reply keyboard. Takes
 *  the same shape `getUserRoles()` returns so callers can pass it through directly. */
export function roleCapabilitiesText(roles: { isLeader?: boolean; isResponsible?: boolean }): string {
  const parts = [M.capabilitiesBase];
  if (roles.isLeader) parts.push(M.capabilitiesLeader);
  if (roles.isResponsible) parts.push(M.capabilitiesResponsible);
  return parts.join("\n\n");
}
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/messages.ts
git commit -m "feat: add role capabilities copy to messages.ts"
```

---

## Task 2: Extract getUserRoles and refactor keyboardForUser

**Files:**
- Modify: `src/bot.ts:51-61`

**Interfaces:**
- Consumes: `findLeadersByTelegramId`, `findResponsibleByTelegramId`, `findByTelegramId`, `loadLeaders`, `loadResponsible`, `loadVisitors` (all already imported in `src/bot.ts`)
- Produces: `getUserRoles(telegramId: number): Promise<{ isVisitor: boolean; isLeader: boolean; isResponsible: boolean }>` — used by Task 3 (link handlers) and Task 4 (`/help`)

This is a pure refactor — behavior of `keyboardForUser` must be unchanged (same three sheet loads, same fallback to `undefined` when no role matches).

- [ ] **Step 1: Replace the function**

In `src/bot.ts`, replace lines 51-61:

```ts
async function keyboardForUser(telegramId: number): Promise<import("grammy").Keyboard | undefined> {
  const [{ leaders }, { responsible }] = await Promise.all([loadLeaders(), loadResponsible()]);
  const isLeader = findLeadersByTelegramId(leaders, telegramId).length > 0;
  const isResponsible = findResponsibleByTelegramId(responsible, telegramId).length > 0;
  if (isLeader || isResponsible) {
    return roleKeyboard({ leader: isLeader, responsible: isResponsible });
  }
  const { visitors } = await loadVisitors();
  if (findByTelegramId(visitors, telegramId)) return roleKeyboard();
  return undefined;
}
```

with:

```ts
async function getUserRoles(
  telegramId: number,
): Promise<{ isVisitor: boolean; isLeader: boolean; isResponsible: boolean }> {
  const [{ leaders }, { responsible }, { visitors }] = await Promise.all([
    loadLeaders(),
    loadResponsible(),
    loadVisitors(),
  ]);
  return {
    isVisitor: !!findByTelegramId(visitors, telegramId),
    isLeader: findLeadersByTelegramId(leaders, telegramId).length > 0,
    isResponsible: findResponsibleByTelegramId(responsible, telegramId).length > 0,
  };
}

async function keyboardForUser(telegramId: number): Promise<import("grammy").Keyboard | undefined> {
  const { isVisitor, isLeader, isResponsible } = await getUserRoles(telegramId);
  if (isLeader || isResponsible) return roleKeyboard({ leader: isLeader, responsible: isResponsible });
  if (isVisitor) return roleKeyboard();
  return undefined;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "refactor: extract getUserRoles from keyboardForUser"
```

---

## Task 3: Send capability follow-up after each check-in

**Files:**
- Modify: `src/bot.ts:88-175` (the three `link:`, `link_leader:`, `link_resp:` callback handlers)

**Interfaces:**
- Consumes: `getUserRoles` (Task 2), `roleCapabilitiesText` (Task 1) — add `roleCapabilitiesText` to the existing `import { M } from "./messages";` line as `import { M, roleCapabilitiesText } from "./messages";`

Each handler re-queries roles **after** the write that just happened, so the message reflects the person's full current role set, not just the role they just linked.

- [ ] **Step 1: Update the messages import**

In `src/bot.ts`, replace:

```ts
import { M } from "./messages";
```

with:

```ts
import { M, roleCapabilitiesText } from "./messages";
```

- [ ] **Step 2: Add follow-up after the visitor check-in confirmation**

In `src/bot.ts`, find (inside the `link:` callback handler):

```ts
  await ctx.deleteMessage();
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.checkedIn(visitor.name, visitor.room || undefined), kb ? { reply_markup: kb } : {});
  const video = await videoForTeam(visitor.team);
```

Replace with:

```ts
  await ctx.deleteMessage();
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.checkedIn(visitor.name, visitor.room || undefined), kb ? { reply_markup: kb } : {});
  const roles = await getUserRoles(ctx.from.id);
  await ctx.reply(roleCapabilitiesText(roles));
  const video = await videoForTeam(visitor.team);
```

- [ ] **Step 3: Add follow-up after the leader check-in confirmation**

In `src/bot.ts`, find (inside the `link_leader:` callback handler):

```ts
  await setLeaderTelegramId(leaderSheet, rowIndex, ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();

  const { admins } = await loadAdmins();
  const role = isSuperAdmin(ctx.from.id)
    ? "superadmin"
    : isAdmin(ctx.from.id, admins)
    ? "admin"
    : "leader";
  await setCommandsForUser(bot, ctx.from.id, role);
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.leaderCheckedIn(leader.name, leader.team), kb ? { reply_markup: kb } : {});
});
```

Replace with:

```ts
  await setLeaderTelegramId(leaderSheet, rowIndex, ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();

  const { admins } = await loadAdmins();
  const role = isSuperAdmin(ctx.from.id)
    ? "superadmin"
    : isAdmin(ctx.from.id, admins)
    ? "admin"
    : "leader";
  await setCommandsForUser(bot, ctx.from.id, role);
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.leaderCheckedIn(leader.name, leader.team), kb ? { reply_markup: kb } : {});
  const roles = await getUserRoles(ctx.from.id);
  await ctx.reply(roleCapabilitiesText(roles));
});
```

- [ ] **Step 4: Add follow-up after the responsible check-in confirmation**

In `src/bot.ts`, find (inside the `link_resp:` callback handler):

```ts
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.respCheckedIn(row.name, titles), kb ? { reply_markup: kb } : {});
});
```

Replace with:

```ts
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.respCheckedIn(row.name, titles), kb ? { reply_markup: kb } : {});
  const roles = await getUserRoles(ctx.from.id);
  await ctx.reply(roleCapabilitiesText(roles));
});
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/bot.ts
git commit -m "feat: send role capabilities message after each check-in"
```

---

## Task 4: Add /help command

**Files:**
- Modify: `src/bot.ts` (add near the other simple commands, after the existing `bot.command("myid", ...)` block at line 75-77)

**Interfaces:**
- Consumes: `getUserRoles` (Task 2), `roleCapabilitiesText` and `M.generalInfo`/`M.mustCheckInFirst` (Task 1, `M.mustCheckInFirst` already exists)

- [ ] **Step 1: Add the command**

In `src/bot.ts`, find:

```ts
bot.command("myid", async (ctx) => {
  await ctx.reply(M.yourId(ctx.from!.id), { parse_mode: "HTML" });
});
```

Add immediately after it:

```ts

bot.command("help", async (ctx) => {
  const roles = await getUserRoles(ctx.from!.id);
  if (!roles.isVisitor && !roles.isLeader && !roles.isResponsible) {
    return ctx.reply(`${M.generalInfo}\n\n${M.mustCheckInFirst}`);
  }
  return ctx.reply(roleCapabilitiesText(roles));
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
git commit -m "feat: add /help command"
```

---

## Task 5: Add /help to the command menu

**Files:**
- Modify: `src/commands.ts:12-16`

**Interfaces:**
- No new exports; `USER_COMMANDS` is consumed by `LEADER_COMMANDS`/`ADMIN_COMMANDS`/`SUPERADMIN_COMMANDS` which all spread it, so every tier picks up `/help` automatically.

- [ ] **Step 1: Add the command entry**

In `src/commands.ts`, replace:

```ts
const USER_COMMANDS = [
  { command: "mc", description: "Майстер-класи сьогодні" },
  { command: "schedule", description: "Розклад" },
  { command: "myevents", description: "Мої реєстрації" },
];
```

with:

```ts
const USER_COMMANDS = [
  { command: "help", description: "Що вміє бот" },
  { command: "mc", description: "Майстер-класи сьогодні" },
  { command: "schedule", description: "Розклад" },
  { command: "myevents", description: "Мої реєстрації" },
];
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/commands.ts
git commit -m "feat: add /help to the command menu"
```

---

## Task 6: Deploy and manually verify

**Files:** none (verification only)

- [ ] **Step 1: Final typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 2: Deploy**

```bash
npx vercel --prod
```

(No `npm run set-webhook` needed — the webhook already points at the stable production domain, which doesn't change between deploys.)

- [ ] **Step 3: Manual verification checklist**

In Telegram, against the deployed bot:

- Send `/start` from a fresh (unlinked) account → confirm the reply includes the "Тут можна: 🎨 / 🗓 / 📋" blurb before the check-in instruction.
- Send `/help` from that same unlinked account → confirm it replies with the general blurb + `M.mustCheckInFirst` ("Спершу відмітьтесь...").
- Check in as a plain visitor (name search → confirm) → confirm a second message appears after the check-in confirmation containing only `M.capabilitiesBase` (no leader/responsible blocks).
- Send `/help` as that now-linked visitor → confirm it replies with the same base-only capability text.
- Check in as a leader (via `/leader` flow) → confirm the follow-up message includes both the base block and the `👑 Як лідер команди` block.
- If a test account can also link as responsible for a masterclass, confirm that follow-up includes base + responsible (and base + leader + responsible if already linked as leader too).
- Confirm `/help` appears in the Telegram command menu (the `/` autocomplete) for a regular linked user.

- [ ] **Step 4: Commit (only if verification surfaced fixes)**

If the manual pass required any code changes, commit them separately with a descriptive message. If everything passed as-is, no commit needed for this task.

---

## Self-Review Notes

- **Spec coverage:** pre-registration blurb (Task 1), post-registration capability message for all 3 link flows (Task 3), role-aware composition via full current role set (Task 2 + 3), `/help` command including unlinked case (Task 4), `/help` in command menu (Task 5) — all design doc sections have a corresponding task.
- **Type consistency:** `getUserRoles` return shape (`{ isVisitor, isLeader, isResponsible }`, Task 2) and `roleCapabilitiesText`'s param shape (`{ isLeader?, isResponsible? }`, Task 1) use matching field names by design — `roleCapabilitiesText(roles)` in Tasks 3-4 passes the `getUserRoles()` result straight through (the extra `isVisitor` field is simply ignored by the function) with no per-call-site mapping needed. Caught and fixed during self-review — an earlier draft had the function's params named `{ leader, responsible }`, which wouldn't have compiled against `getUserRoles`'s output.
