# Phishing-Awareness "Caught" Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log clicks on a phishing-awareness lure link (`t.me/<bot>?start=caught`) and let the masterclass's responsible person reveal, via `/caught`, which of their registered attendees clicked it.

**Architecture:** A new `PhishCatches` sheet tab (already created) is an append-only click log, written by a new `caught` branch in the existing `/start` handler and read by a new `/caught` command that reuses the existing `myOccurrencesToday`/`activeRegs` machinery `/notifymc` already relies on.

**Tech Stack:** grammY (Telegram bot framework), TypeScript, Google Sheets API (via `src/sheets.ts`).

## Global Constraints

- No test framework and no local dev server exist in this repo — `npm run typecheck` is the only automated check; behavior is verified manually after `npx vercel --prod` (per `CLAUDE.md`).
- All user-facing strings are Ukrainian and live in the `M` object in `src/messages.ts`.
- The `PhishCatches` tab already exists in the spreadsheet with header row `Telegram ID | Caught at` — do not create or rename it.
- `config.botUsername` (env `BOT_USERNAME`) already exists — no new env var needed.
- `headerIndex()` matches headers case-insensitively after trimming — exact casing of `"Telegram ID"` / `"Caught at"` isn't required, but use that exact text for readability.

---

### Task 1: Data layer — `PhishCatches` tab access

**Files:**
- Modify: `src/config.ts:41` (insert after `videosTab: "Videos",`)
- Create: `src/phishing.ts`

**Interfaces:**
- Consumes: `getRows(tab: string): Promise<string[][]>`, `appendRow(tab: string, values: string[]): Promise<void>`, `headerIndex(headerRow: string[], header: string): number` (all from `src/sheets.ts`, already exported); `config.phishCatchesTab: string`, `nowStamp(): string` (from `src/config.ts`, already exported).
- Produces: `interface PhishCatch { telegramId: string; caughtAt: string }`, `logCatch(telegramId: string): Promise<void>`, `loadCatches(): Promise<PhishCatch[]>` — both exported from `src/phishing.ts`.

- [ ] **Step 1: Add the tab name to config**

In `src/config.ts`, change:

```ts
  videosTab: "Videos",
```

to:

```ts
  videosTab: "Videos",
  phishCatchesTab: "PhishCatches",
```

- [ ] **Step 2: Create `src/phishing.ts`**

```ts
import { config, nowStamp } from "./config";
import { appendRow, getRows, headerIndex } from "./sheets";

export interface PhishCatch {
  telegramId: string;
  caughtAt: string;
}

export async function logCatch(telegramId: string): Promise<void> {
  await appendRow(config.phishCatchesTab, [telegramId, nowStamp()]);
}

export async function loadCatches(): Promise<PhishCatch[]> {
  const rows = await getRows(config.phishCatchesTab);
  if (rows.length === 0) return [];
  const header = rows[0];
  const idCol = headerIndex(header, "Telegram ID");
  const atCol = headerIndex(header, "Caught at");
  const catches: PhishCatch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const telegramId = (rows[i][idCol] ?? "").trim();
    if (!telegramId) continue;
    catches.push({ telegramId, caughtAt: (rows[i][atCol] ?? "").trim() });
  }
  return catches;
}
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/phishing.ts
git commit -m "$(cat <<'EOF'
feat(phishing): add PhishCatches data layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Messages

**Files:**
- Modify: `src/messages.ts:188` (insert before the closing `};` of the `M` object)

**Interfaces:**
- Consumes: nothing new.
- Produces: `M.phishCaught: string`, `M.caughtHeader(title: string, slot: string): string`, `M.noCatches: string`, `M.caughtChoose: string` — all on the existing exported `M` object.

- [ ] **Step 1: Add the new message keys**

In `src/messages.ts`, change:

```ts
  mcNotifySent: (sent: number, total: number, title: string, slot: string) =>
    `Надіслано ${sent}/${total} учасникам «${title}» (${slot}) ✅`,
};
```

to:

```ts
  mcNotifySent: (sent: number, total: number, title: string, slot: string) =>
    `Надіслано ${sent}/${total} учасникам «${title}» (${slot}) ✅`,

  // Phishing awareness
  phishCaught: "🎣 Ви попались! Це був навчальний фішинг — обговоримо це на майстер-класі.",
  caughtHeader: (title: string, slot: string) => `Спіймані на «${title}» (${slot}):`,
  noCatches: "— поки ніхто не попався",
  caughtChoose: "Результати якого майстер-класу показати?",
};
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/messages.ts
git commit -m "$(cat <<'EOF'
feat(phishing): add reveal/caught-list messages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `/start caught` deep link

**Files:**
- Modify: `src/bot.ts:51` (import block) and `src/bot.ts:90-102` (`/start` handler)

**Interfaces:**
- Consumes: `logCatch(telegramId: string): Promise<void>` (Task 1, `src/phishing.ts`), `M.phishCaught: string` (Task 2, `src/messages.ts`, already imported into `bot.ts` as `M`).
- Produces: nothing new consumed by later tasks — this is a leaf change.

- [ ] **Step 1: Import `logCatch`**

In `src/bot.ts`, change:

```ts
import {
  addResponsible,
  findResponsibleByTelegramId,
  linkResponsibleRows,
  loadResponsible,
  removeResponsibleByRow,
  searchResponsibleByName,
} from "./responsible";
```

to:

```ts
import {
  addResponsible,
  findResponsibleByTelegramId,
  linkResponsibleRows,
  loadResponsible,
  removeResponsibleByRow,
  searchResponsibleByName,
} from "./responsible";
import { logCatch } from "./phishing";
```

- [ ] **Step 2: Add the `caught` branch to the `/start` handler**

In `src/bot.ts`, change:

```ts
bot.command("start", async (ctx) => {
  const payload = (ctx.match ?? "").trim();
  const medMatch = /^med_(\d+)$/.exec(payload);
  if (medMatch) return handleDoctorScan(ctx, Number(medMatch[1]));

  const { visitors } = await loadVisitors();
```

to:

```ts
bot.command("start", async (ctx) => {
  const payload = (ctx.match ?? "").trim();
  const medMatch = /^med_(\d+)$/.exec(payload);
  if (medMatch) return handleDoctorScan(ctx, Number(medMatch[1]));
  if (payload === "caught") {
    await logCatch(String(ctx.from!.id));
    return ctx.reply(M.phishCaught);
  }

  const { visitors } = await loadVisitors();
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "$(cat <<'EOF'
feat(phishing): log and reply on /start caught

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `/caught` reveal command

**Files:**
- Modify: `src/bot.ts:52` (import line added in Task 3) and `src/bot.ts` (insert new code between the `mn:` callback block ending and the `// --- keyboard button handlers ---` comment)

**Interfaces:**
- Consumes: `loadCatches(): Promise<PhishCatch[]>` (Task 1, `src/phishing.ts`); `M.caughtHeader`, `M.noCatches`, `M.caughtChoose`, `M.notResponsible`, `M.noMyMcToday` (Task 2 + existing); `MCOccurrence` interface, `myOccurrencesToday(telegramId: number): Promise<MCOccurrence[] | null>` (already defined in `src/bot.ts`); `activeRegs`, `loadMCRegistrations` (already imported from `./masterclasses`); `InlineKeyboard` (already imported from `grammy`).
- Produces: nothing new consumed by later tasks — this is the last code task.

- [ ] **Step 1: Import `loadCatches`**

In `src/bot.ts`, change:

```ts
import { logCatch } from "./phishing";
```

to:

```ts
import { loadCatches, logCatch } from "./phishing";
```

- [ ] **Step 2: Insert the reveal command after the `mn:` callback block**

Find this exact block in `src/bot.ts` (the end of the `/notifymc` picker callback):

```ts
bot.callbackQuery(/^mn:(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  // The notify text is embedded in the picker message («…»), like the renameteam flow.
  const msgText = ctx.callbackQuery.message?.text ?? "";
  const textMatch = msgText.match(/«([\s\S]+)»/);
  if (!textMatch) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.mcNotifyNoText);
  }
  const occ = await myOccurrencesToday(ctx.from.id);
  const o = occ?.[idx];
  if (!o) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.noMyMcToday);
  }
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();
  return notifyOccurrence(ctx, o, textMatch[1]);
});

// --- keyboard button handlers (must be before message:text catch-all) ---
```

Replace it with (the same block, plus the new command/callback inserted before the `// --- keyboard button handlers ---` comment):

```ts
bot.callbackQuery(/^mn:(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  // The notify text is embedded in the picker message («…»), like the renameteam flow.
  const msgText = ctx.callbackQuery.message?.text ?? "";
  const textMatch = msgText.match(/«([\s\S]+)»/);
  if (!textMatch) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.mcNotifyNoText);
  }
  const occ = await myOccurrencesToday(ctx.from.id);
  const o = occ?.[idx];
  if (!o) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.noMyMcToday);
  }
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();
  return notifyOccurrence(ctx, o, textMatch[1]);
});

async function renderCaught(ctx: Context, o: MCOccurrence) {
  const [regs, catches] = await Promise.all([loadMCRegistrations(), loadCatches()]);
  const taken = activeRegs(regs, o.date, o.slot, o.mc.id);
  const earliestByTelegramId = new Map<string, string>();
  for (const c of catches) {
    const existing = earliestByTelegramId.get(c.telegramId);
    if (!existing || c.caughtAt < existing) earliestByTelegramId.set(c.telegramId, c.caughtAt);
  }
  const caught = taken
    .filter((r) => earliestByTelegramId.has(r.telegramId))
    .map((r) => ({ name: r.name, caughtAt: earliestByTelegramId.get(r.telegramId)! }))
    .sort((a, b) => a.caughtAt.localeCompare(b.caughtAt));
  const lines = [M.caughtHeader(o.mc.title, o.slot)];
  if (caught.length === 0) lines.push(M.noCatches);
  else for (const c of caught) lines.push(`• ${c.name} — ${c.caughtAt}`);
  return ctx.reply(lines.join("\n"));
}

bot.command("caught", async (ctx) => {
  const occ = await myOccurrencesToday(ctx.from!.id);
  if (occ === null) return ctx.reply(M.notResponsible);
  if (occ.length === 0) return ctx.reply(M.noMyMcToday);
  if (occ.length === 1) return renderCaught(ctx, occ[0]);
  const kb = new InlineKeyboard();
  occ.forEach((o, i) => kb.text(`${o.mc.title} (${o.slot})`, `cn:${i}`).row());
  return ctx.reply(M.caughtChoose, { reply_markup: kb });
});

bot.callbackQuery(/^cn:(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  const occ = await myOccurrencesToday(ctx.from.id);
  const o = occ?.[idx];
  await ctx.answerCallbackQuery();
  if (!o) return ctx.editMessageText(M.noMyMcToday);
  await ctx.deleteMessage();
  return renderCaught(ctx, o);
});

// --- keyboard button handlers (must be before message:text catch-all) ---
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "$(cat <<'EOF'
feat(phishing): add /caught reveal command

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Deploy and manually verify

**Files:** none (no code changes — deployment and manual verification only).

**Interfaces:** none.

- [ ] **Step 1: Deploy**

Run: `npx vercel --prod`
Expected: deployment succeeds and prints the production URL (should be the existing stable domain — `npm run set-webhook` is only needed if the domain actually changed, which it shouldn't for a routine deploy).

- [ ] **Step 2: Click your own trap link**

In Telegram, open `https://t.me/<BOT_USERNAME>?start=caught` (substitute your real `BOT_USERNAME`) and tap Start.
Expected: the bot privately replies with `🎣 Ви попались! Це був навчальний фішинг — обговоримо це на майстер-класі.`

- [ ] **Step 3: Confirm the sheet row**

Open the `PhishCatches` tab in the spreadsheet.
Expected: a new row with your Telegram ID and a timestamp.

- [ ] **Step 4: Confirm the reveal command**

As the responsible person for a masterclass you're registered as responsible for (with an occurrence scheduled today), send `/caught`.
Expected: if you're also a registered attendee of that occurrence, your name and catch time appear; otherwise `M.noCatches` (`— поки ніхто не попався`) is shown.

- [ ] **Step 5: Confirm repeat-click dedup**

Click the trap link a second time, then run `/caught` again.
Expected: you still appear only once in the list (with the original, earlier timestamp), even though `PhishCatches` now has two rows for your ID.
