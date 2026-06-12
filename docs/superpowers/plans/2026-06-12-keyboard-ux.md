# Keyboard UX & Leader Flow Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace typed commands with a persistent bottom keyboard per role, fix room display after check-in, switch Videos lookup to ID-based, and fix the admin+leader video handler.

**Architecture:** New `src/keyboards.ts` exports role-specific `Keyboard` objects. Command logic for events/schedule/myevents is extracted into plain async functions and reused by both `bot.command()` and `bot.hears()` handlers. Data-layer changes are isolated to `src/checkin.ts` and `src/config.ts`.

**Tech Stack:** grammY (`Keyboard`, `bot.hears`), Google Sheets API, TypeScript, Vercel serverless.

---

## File Map

| File | Change |
|---|---|
| `src/config.ts` | Add `roomHeader` env var |
| `src/checkin.ts` | Add `room` to `Visitor`; ID-based Videos lookup; `updateTeamVideo` uses ID |
| `src/messages.ts` | Update `checkedIn` to accept room; add button labels and usage hints |
| `src/keyboards.ts` | **New** — `visitorKeyboard()` and `leaderKeyboard()` |
| `src/bot.ts` | Extract command logic; add `bot.hears()`; attach keyboards; fix video handler |

---

## Task 1: Add room column to config and Visitor

**Files:**
- Modify: `src/config.ts`
- Modify: `src/checkin.ts`

- [ ] **Add `roomHeader` to config**

In `src/config.ts`, add after `teamHeader`:

```typescript
roomHeader: process.env.ROOM_HEADER ?? "Кімната",
```

- [ ] **Add `room` field to Visitor interface**

In `src/checkin.ts`, update the `Visitor` interface:

```typescript
export interface Visitor {
  rowIndex: number;
  name: string;
  team: string;
  room: string;
  telegramId: string;
  checkedIn: string;
}
```

- [ ] **Load room column in `loadVisitors`**

Update `cols` and the visitor push in `loadVisitors()`:

```typescript
const cols = {
  name: headerIndex(header, config.nameHeader),
  checkin: headerIndex(header, config.checkinHeader),
  telegramId: headerIndex(header, config.telegramIdHeader),
  team: config.teamHeader ? headerIndex(header, config.teamHeader) : -1,
  room: config.roomHeader ? headerIndex(header, config.roomHeader) : -1,
};
```

```typescript
visitors.push({
  rowIndex: i,
  name,
  team: cols.team >= 0 ? (row[cols.team] ?? "").trim() : "",
  room: cols.room >= 0 ? (row[cols.room] ?? "").trim() : "",
  telegramId: (row[cols.telegramId] ?? "").trim(),
  checkedIn: (row[cols.checkin] ?? "").trim(),
});
```

- [ ] **Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/config.ts src/checkin.ts
git commit -m "feat: add room column to Visitor"
```

---

## Task 2: Show room in check-in reply

**Files:**
- Modify: `src/messages.ts`
- Modify: `src/bot.ts`

- [ ] **Update `checkedIn` message to include optional room**

In `src/messages.ts`, replace:

```typescript
checkedIn: (name: string) => `Готово, ${name}! Ви відмічені ✅\nГарного табору! 🎉`,
```

With:

```typescript
checkedIn: (name: string, room?: string) =>
  `Готово, ${name}! Ви відмічені ✅${room ? `\nВаша кімната: ${room}` : ""}\nГарного табору! 🎉`,
```

- [ ] **Pass room to check-in reply in bot.ts**

In `src/bot.ts`, in the `link` callback, update:

```typescript
await ctx.editMessageText(M.checkedIn(visitor.name));
```

to:

```typescript
await ctx.editMessageText(M.checkedIn(visitor.name, visitor.room || undefined));
```

- [ ] **Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/messages.ts src/bot.ts
git commit -m "feat: show room number in check-in reply"
```

---

## Task 3: Switch Videos lookup to ID-based

**Files:**
- Modify: `src/checkin.ts`

- [ ] **Update `videoForTeam` to use ID column**

Replace the existing `videoForTeam` function:

```typescript
export async function videoForTeam(
  teamId: string,
): Promise<{ fileId: string; isVideoNote: boolean } | null> {
  try {
    const rows = await getRows(config.videosTab);
    if (rows.length === 0) {
      if (config.defaultVideoFileId) return { fileId: config.defaultVideoFileId, isVideoNote: false };
      return null;
    }
    const header = rows[0];
    const idCol = headerIndex(header, "ID");
    const fileIdCol = headerIndex(header, "File ID");
    const typeCol = headerIndex(header, "Type");
    const target = teamId.trim();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const id = (row[idCol] ?? "").trim();
      const fileId = (row[fileIdCol] ?? "").trim();
      if (id === target && fileId) {
        const type = (row[typeCol] ?? "").trim();
        return { fileId, isVideoNote: type === "video_note" };
      }
    }
  } catch {
    // Videos tab is optional
  }
  if (config.defaultVideoFileId) return { fileId: config.defaultVideoFileId, isVideoNote: false };
  return null;
}
```

- [ ] **Update `updateTeamVideo` to use ID column**

Replace the existing `updateTeamVideo` function:

```typescript
export async function updateTeamVideo(
  teamId: string,
  fileId: string,
  isVideoNote: boolean,
): Promise<void> {
  const rows = await getRows(config.videosTab);
  const type = isVideoNote ? "video_note" : "video";
  const target = teamId.trim();

  if (rows.length > 0) {
    const header = rows[0];
    const idCol = headerIndex(header, "ID");
    const fileIdCol = headerIndex(header, "File ID");
    const typeCol = headerIndex(header, "Type");
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][idCol] ?? "").trim() === target) {
        await updateCell(config.videosTab, i, fileIdCol, fileId);
        await updateCell(config.videosTab, i, typeCol, type);
        return;
      }
    }
  }
  // Row not found — append. ID and Team are both set to teamId.
  await appendRow(config.videosTab, [teamId, teamId, fileId, type]);
}
```

- [ ] **Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/checkin.ts
git commit -m "feat: switch Videos tab lookup to ID-based exact match"
```

---

## Task 4: Fix video handler — admin + leader combo

**Files:**
- Modify: `src/bot.ts`

- [ ] **Remove early return after admin file_id reply**

Find the `message:video` / `message:video_note` handler in `src/bot.ts`. The current structure is:

```typescript
if (isSuperAdmin(ctx.from?.id)) {
  return ctx.reply(...);  // ← early return prevents leader check
}
const { admins } = await loadAdmins();
if (isAdmin(ctx.from?.id, admins)) {
  return ctx.reply(...);  // ← same
}
const { leaders } = await loadLeaders();
```

Replace with:

```typescript
let sentFileId = false;

if (isSuperAdmin(ctx.from?.id)) {
  await ctx.reply(`file_id:\n<code>${fileId}</code>`, { parse_mode: "HTML" });
  sentFileId = true;
} else {
  const { admins } = await loadAdmins();
  if (isAdmin(ctx.from?.id, admins)) {
    await ctx.reply(`file_id:\n<code>${fileId}</code>`, { parse_mode: "HTML" });
    sentFileId = true;
  }
}

const { leaders } = await loadLeaders();
const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
if (mine.length === 0) {
  if (!sentFileId) return;
  return;
}

const myTeams = [...new Set(mine.map((l) => l.team))];

if (myTeams.length === 1) {
  await updateTeamVideo(myTeams[0], fileId, isVideoNote);
  return ctx.reply(M.videoUpdated(myTeams[0]));
}

const caption = (ctx.message.caption ?? "").trim();
const matched = myTeams.find((t) => t.toLowerCase() === caption.toLowerCase());
if (matched) {
  await updateTeamVideo(matched, fileId, isVideoNote);
  return ctx.reply(M.videoUpdated(matched));
}

return ctx.reply(M.videoMultiTeamHint(myTeams.join(", ")));
```

- [ ] **Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/bot.ts
git commit -m "fix: admin+leader video handler — save to team after showing file_id"
```

---

## Task 5: Create `src/keyboards.ts`

**Files:**
- Create: `src/keyboards.ts`

- [ ] **Create the keyboards module**

```typescript
import { Keyboard } from "grammy";

export const BTN = {
  events: "📅 Події сьогодні",
  schedule: "🗓 Розклад",
  myEvents: "📋 Мої реєстрації",
  notifyTeam: "📢 Сповістити команду",
  renameTeam: "✏️ Перейменувати команду",
} as const;

export function visitorKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.events).text(BTN.schedule).row()
    .text(BTN.myEvents)
    .resized()
    .persistent();
}

export function leaderKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.events).text(BTN.schedule).row()
    .text(BTN.myEvents).row()
    .text(BTN.notifyTeam).row()
    .text(BTN.renameTeam)
    .resized()
    .persistent();
}
```

- [ ] **Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/keyboards.ts
git commit -m "feat: add role-based reply keyboards"
```

---

## Task 6: Add button usage hints to messages

**Files:**
- Modify: `src/messages.ts`

- [ ] **Add hint strings for leader action buttons**

Add at the end of the `M` object (before the closing `}`):

```typescript
notifyTeamHint: "Напишіть команду з текстом:\n/notifyteam <ваше повідомлення>",
renameTeamHint: "Напишіть команду з новою назвою:\n/renameteam <нова назва>",
```

- [ ] **Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/messages.ts
git commit -m "feat: add usage hints for leader keyboard buttons"
```

---

## Task 7: Extract command logic and add `bot.hears()` handlers

**Files:**
- Modify: `src/bot.ts`

- [ ] **Import keyboards and BTN**

At the top of `src/bot.ts`, add:

```typescript
import { BTN, leaderKeyboard, visitorKeyboard } from "./keyboards";
```

- [ ] **Extract events, schedule, myevents into shared functions**

Before the command registrations, add these three functions:

```typescript
async function handleEvents(ctx: Context) {
  const [events, regs] = await Promise.all([loadEvents(), loadRegistrations()]);
  const today = todayEvents(events);
  if (today.length === 0) return ctx.reply(M.noEventsToday);
  const kb = new InlineKeyboard();
  const lines: string[] = [M.eventsToday, ""];
  for (const e of today) {
    const taken = activeRegs(regs, e.id);
    const mine = taken.some((r) => r.telegramId === String(ctx.from!.id));
    const free = e.capacity > 0 ? ` (${M.spotsLeft(Math.max(0, e.capacity - taken.length))})` : "";
    lines.push(`• ${eventLine(e)}${free}${mine ? " ✅" : ""}`);
    kb.text(
      mine ? `❌ ${e.title}` : `📝 ${e.title}`,
      mine ? `unreg:${e.id}` : `reg:${e.id}`,
    ).row();
  }
  return ctx.reply(lines.join("\n"), { reply_markup: kb });
}

async function handleSchedule(ctx: Context) {
  const events = upcomingEvents(await loadEvents());
  if (events.length === 0) return ctx.reply(M.noEventsToday);
  const byDate = new Map<string, string[]>();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date)!.push(`  • ${eventLine(e)}`);
  }
  const lines = [M.scheduleTitle, ""];
  for (const [date, items] of byDate) lines.push(date, ...items, "");
  return ctx.reply(lines.join("\n"));
}

async function handleMyEvents(ctx: Context) {
  const [events, regs] = await Promise.all([loadEvents(), loadRegistrations()]);
  const mine = regs.filter(
    (r) => r.telegramId === String(ctx.from!.id) && !r.cancelled,
  );
  if (mine.length === 0) return ctx.reply(M.myEventsEmpty);
  const lines = [M.myEventsTitle, ""];
  for (const r of mine) {
    const e = events.find((ev) => ev.id === r.eventId);
    if (e) lines.push(`• ${e.date} ${eventLine(e)}`);
  }
  return ctx.reply(lines.join("\n"));
}
```

- [ ] **Replace command handler bodies to call the shared functions**

```typescript
bot.command("events", handleEvents);
bot.command("schedule", handleSchedule);
bot.command("myevents", handleMyEvents);
```

- [ ] **Add `bot.hears()` handlers before `message:text`**

Add these before the `bot.on("message:text", ...)` handler:

```typescript
bot.hears(BTN.events, handleEvents);
bot.hears(BTN.schedule, handleSchedule);
bot.hears(BTN.myEvents, handleMyEvents);
bot.hears(BTN.notifyTeam, (ctx) => ctx.reply(M.notifyTeamHint));
bot.hears(BTN.renameTeam, (ctx) => ctx.reply(M.renameTeamHint));
```

- [ ] **Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/bot.ts
git commit -m "feat: extract command logic and add keyboard button hears handlers"
```

---

## Task 8: Attach keyboards at check-in and /start

**Files:**
- Modify: `src/bot.ts`

- [ ] **Add helper to pick the right keyboard**

Add after the imports block:

```typescript
async function keyboardForUser(telegramId: number): Promise<import("grammy").Keyboard | undefined> {
  const { leaders } = await loadLeaders();
  const isLeader = findLeadersByTelegramId(leaders, telegramId).length > 0;
  if (isLeader) return leaderKeyboard();
  const { visitors } = await loadVisitors();
  if (findByTelegramId(visitors, telegramId)) return visitorKeyboard();
  return undefined;
}
```

- [ ] **Attach keyboard after visitor links**

In the `link` callback, after sending the check-in confirmation, add:

```typescript
const kb = await keyboardForUser(ctx.from.id);
if (kb) {
  await ctx.reply(M.keyboardReady, { reply_markup: kb });
}
```

Also add `keyboardReady` to `src/messages.ts`:

```typescript
keyboardReady: "Ось ваше меню 👇",
```

- [ ] **Attach keyboard after leader links**

In the `link_leader` callback, after `setCommandsForUser`, add:

```typescript
await ctx.reply(M.keyboardReady, { reply_markup: leaderKeyboard() });
```

- [ ] **Restore keyboard on `/start` when already linked**

Update the `/start` handler:

```typescript
bot.command("start", async (ctx) => {
  const { visitors } = await loadVisitors();
  const me = findByTelegramId(visitors, ctx.from!.id);
  if (me) {
    const kb = await keyboardForUser(ctx.from!.id);
    return ctx.reply(M.alreadyLinked(me.name), kb ? { reply_markup: kb } : {});
  }
  return ctx.reply(M.welcome);
});
```

- [ ] **Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/bot.ts src/messages.ts
git commit -m "feat: attach role-based keyboard at check-in and /start"
```

---

## Task 9: Deploy and smoke-test

- [ ] **Deploy to Vercel**

```bash
npx vercel --prod
npm run set-webhook
```

- [ ] **Smoke-test visitor flow**

  1. Open a fresh Telegram account (or unlink existing)
  2. Send `/start` → see welcome text, no keyboard
  3. Type your name → confirm button appears
  4. Click confirm → see check-in message with room + keyboard appears
  5. Tap `📅 Події сьогодні` → see today's events
  6. Tap `🗓 Розклад` → see schedule
  7. Tap `📋 Мої реєстрації` → see registrations

- [ ] **Smoke-test leader flow**

  1. Use `/addleader <team> <name>` to add yourself
  2. Type your name → `👑` button appears → click it
  3. Leader keyboard appears (5 buttons)
  4. Tap `📢 Сповістити команду` → see hint
  5. Tap `✏️ Перейменувати команду` → see hint
  6. Send a video note → file_id echoed AND video saved to team

- [ ] **Smoke-test video admin+leader combo**

  1. Ensure your account is both superadmin and leader
  2. Send a video note
  3. Should receive file_id reply AND "video updated for team X"
