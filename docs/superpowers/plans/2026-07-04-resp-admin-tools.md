# Responsible-Person Admin Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/syncresp` (bulk-import `MCResponsible` rows from the masterclass catalog's `Відповідальний` column) and replace `/delresp`'s typed-name form with a button picker.

**Architecture:** Task 1 adds a pure text-splitting helper to `src/masterclasses.ts` and a new `bot.command("syncresp", ...)` that loops the catalog calling the existing `addResponsible`. Task 2 replaces the old name-based `removeResponsible` in `src/responsible.ts` with a row-indexed `removeResponsibleByRow`, and replaces the old `/delresp` handler with a grouped inline-keyboard picker plus a two-step (select → confirm) callback flow, reusing the `mcnoop` no-op callback already registered for the combined masterclass list.

**Tech Stack:** TypeScript, grammY, googleapis (Google Sheets v4), Vercel serverless.

**Specs:**
- `docs/superpowers/specs/2026-07-04-sync-responsible-design.md`
- `docs/superpowers/specs/2026-07-04-delresp-picker-design.md`

## Global Constraints

- No test framework and no local dev server: verify with `npm run typecheck` (must pass clean) plus diff inspection. Runtime behavior is confirmed after deploy (`npx vercel --prod`); `npm run set-webhook` is **not** needed since the webhook already points at the stable production domain.
- All user-facing strings are Ukrainian and live only in the `M` object in `src/messages.ts`.
- `/syncresp` is additive only — it must never remove or modify an existing `MCResponsible` row, only add missing ones via the existing `addResponsible(mcId, name)`, which already handles duplicate detection.
- `/delresp`'s new picker must reuse the existing `bot.callbackQuery("mcnoop", ...)` handler (`src/bot.ts:289`) for its inert group-header buttons — do not register a second no-op handler.
- Both `/syncresp` and `/delresp` are zero-argument commands and belong in `ADMIN_COMMANDS` (`src/commands.ts`) per the existing convention ("only zero-arg commands belong in the slash menu"); `/addresp` still takes arguments and stays excluded.
- Callback data must stay under Telegram's 64-byte limit (all formats below — `delresp:<rowIndex>`, `delrespyes:<rowIndex>`, `delrespcancel` — fit trivially).

---

### Task 1: `/syncresp` — bulk-import responsible persons from the catalog

**Files:**
- Modify: `src/masterclasses.ts:71` (insert `splitResponsibleNames` after `loadMasterclasses`)
- Modify: `src/messages.ts:99-101`
- Modify: `src/bot.ts` (import, new command handler after the existing `delresp` handler)
- Modify: `src/commands.ts:20-23`

**Interfaces:**
- Consumes: `loadMasterclasses(): Promise<Masterclass[]>`, `addResponsible(mcId: string, name: string): Promise<"ok" | "duplicate">` (both existing, unchanged).
- Produces: `splitResponsibleNames(text: string): string[]`, exported from `src/masterclasses.ts` — used again by no other task in this plan, but is the reusable primitive this feature is built on.

- [ ] **Step 1: Add `splitResponsibleNames` to `src/masterclasses.ts`**

Insert immediately after the closing `}` of `loadMasterclasses` (after line 71, before `export async function loadMCSchedule`):

```ts

/** Splits a catalog "Відповідальний" cell into individual names, e.g.
 *  "Лєна Бабій і Інна Коляденко" -> ["Лєна Бабій", "Інна Коляденко"]. */
export function splitResponsibleNames(text: string): string[] {
  return text
    .split(/\s+(?:і|та)\s+|\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}
```

- [ ] **Step 2: Add sync messages to `src/messages.ts`**

Replace lines 99-101:

```ts
  respNotFoundAdmin: (name: string, mcId: string) =>
    `Відповідального ${name} для МК ${mcId} не знайдено.`,

  // Superadmin commands
```

with:

```ts
  respNotFoundAdmin: (name: string, mcId: string) =>
    `Відповідального ${name} для МК ${mcId} не знайдено.`,
  mcCatalogUnavailable: "Каталог майстер-класів недоступний.",
  mcSyncTitle: "Синхронізація відповідальних:",
  mcSyncAdded: (name: string, title: string) => `✅ ${name} — ${title}`,
  mcSyncDuplicate: (name: string, title: string) => `⚪ ${name} — ${title} (вже є)`,
  mcSyncSummary: (added: number, existing: number) =>
    `Додано: ${added}, вже було: ${existing}.`,

  // Superadmin commands
```

- [ ] **Step 3: Import `splitResponsibleNames` in `src/bot.ts`**

Replace the `./masterclasses` import block:

```ts
import {
  activeRegs,
  loadMasterclasses,
  loadMCRegistrations,
  loadMCSchedule,
  Masterclass,
  register,
  todaySlots,
  unregister,
} from "./masterclasses";
```

with:

```ts
import {
  activeRegs,
  loadMasterclasses,
  loadMCRegistrations,
  loadMCSchedule,
  Masterclass,
  register,
  splitResponsibleNames,
  todaySlots,
  unregister,
} from "./masterclasses";
```

- [ ] **Step 4: Add the `syncresp` command handler in `src/bot.ts`**

Immediately after the existing `delresp` handler (ends with `});` at line 417, right before the `// --- superadmin commands ---` comment), add:

```ts

bot.command("syncresp", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const mcs = await loadMasterclasses();
  if (mcs.length === 0) return ctx.reply(M.mcCatalogUnavailable);
  const lines: string[] = [M.mcSyncTitle, ""];
  let added = 0;
  let existing = 0;
  for (const mc of mcs) {
    for (const name of splitResponsibleNames(mc.responsible)) {
      const result = await addResponsible(mc.id, name);
      if (result === "ok") {
        lines.push(M.mcSyncAdded(name, mc.title));
        added++;
      } else {
        lines.push(M.mcSyncDuplicate(name, mc.title));
        existing++;
      }
    }
  }
  lines.push("", M.mcSyncSummary(added, existing));
  return ctx.reply(lines.join("\n"));
});
```

- [ ] **Step 5: Add `/syncresp` to the admin command menu in `src/commands.ts`**

Replace lines 20-23:

```ts
const ADMIN_COMMANDS = [
  ...LEADER_COMMANDS,
  { command: "listleaders", description: "Список лідерів" },
];
```

with:

```ts
const ADMIN_COMMANDS = [
  ...LEADER_COMMANDS,
  { command: "listleaders", description: "Список лідерів" },
  { command: "syncresp", description: "Синхронізувати відповідальних" },
];
```

- [ ] **Step 6: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/masterclasses.ts src/messages.ts src/bot.ts src/commands.ts
git commit -m "feat: add /syncresp to bulk-import responsible persons from catalog"
```

---

### Task 2: `/delresp` button picker

**Files:**
- Modify: `src/responsible.ts:103-111` (replace `removeResponsible` with `removeResponsibleByRow`)
- Modify: `src/messages.ts` (remove `delRespUsage`/`respNotFoundAdmin`, add picker messages)
- Modify: `src/bot.ts` (import change; replace the `delresp` handler with a picker builder + 3 callback handlers)
- Modify: `src/commands.ts` (add `delresp` to `ADMIN_COMMANDS`)

**Interfaces:**
- Consumes (Task 1 + existing): `loadResponsible(): Promise<ResponsibleSheet>` (existing, returns `{ responsible: Responsible[], cols }` where `Responsible` has `rowIndex: number; mcId: string; name: string; telegramId: string`), `loadMasterclasses(): Promise<Masterclass[]>`, `bot.callbackQuery("mcnoop", ...)` (existing, `src/bot.ts:289` — reused as-is, not modified).
- Produces: `removeResponsibleByRow(rowIndex: number): Promise<void>`, exported from `src/responsible.ts` — no other task in this plan consumes it (used only by the callback handlers added in this same task).

- [ ] **Step 1: Replace `removeResponsible` with `removeResponsibleByRow` in `src/responsible.ts`**

Replace lines 103-111:

```ts
export async function removeResponsible(mcId: string, name: string): Promise<boolean> {
  const { responsible } = await loadResponsible();
  const row = responsible.find(
    (r) => r.mcId === mcId && normalizeStr(r.name) === normalizeStr(name),
  );
  if (!row) return false;
  await clearRow(config.responsibleTab, row.rowIndex);
  return true;
}
```

with:

```ts
export async function removeResponsibleByRow(rowIndex: number): Promise<void> {
  await clearRow(config.responsibleTab, rowIndex);
}
```

- [ ] **Step 2: Update `src/messages.ts`**

Replace the full block from `addRespUsage` through `mcSyncSummary` (added in Task 1 Step 2 — this replaces lines 89-100 as they now stand after Task 1):

```ts
  addRespUsage: "Використання: /addresp <ID майстер-класу> <Прізвище та ім'я>",
  delRespUsage: "Використання: /delresp <ID майстер-класу> <Прізвище та ім'я>",
  mcNotFoundAdmin: (mcId: string) =>
    `Майстер-клас з ID ${mcId} не знайдено у каталозі.`,
  respAdded: (name: string, title: string) =>
    `${name} — відповідальний за «${title}» ✅`,
  respDuplicate: (name: string, title: string) =>
    `${name} вже відповідальний за «${title}».`,
  respRemoved: (name: string, title: string) =>
    `${name} більше не відповідальний за «${title}» ✅`,
  respNotFoundAdmin: (name: string, mcId: string) =>
    `Відповідального ${name} для МК ${mcId} не знайдено.`,
  mcCatalogUnavailable: "Каталог майстер-класів недоступний.",
  mcSyncTitle: "Синхронізація відповідальних:",
  mcSyncAdded: (name: string, title: string) => `✅ ${name} — ${title}`,
  mcSyncDuplicate: (name: string, title: string) => `⚪ ${name} — ${title} (вже є)`,
  mcSyncSummary: (added: number, existing: number) =>
    `Додано: ${added}, вже було: ${existing}.`,
```

with:

```ts
  addRespUsage: "Використання: /addresp <ID майстер-класу> <Прізвище та ім'я>",
  mcNotFoundAdmin: (mcId: string) =>
    `Майстер-клас з ID ${mcId} не знайдено у каталозі.`,
  respAdded: (name: string, title: string) =>
    `${name} — відповідальний за «${title}» ✅`,
  respDuplicate: (name: string, title: string) =>
    `${name} вже відповідальний за «${title}».`,
  respRemoved: (name: string, title: string) =>
    `${name} більше не відповідальний за «${title}» ✅`,
  mcCatalogUnavailable: "Каталог майстер-класів недоступний.",
  mcSyncTitle: "Синхронізація відповідальних:",
  mcSyncAdded: (name: string, title: string) => `✅ ${name} — ${title}`,
  mcSyncDuplicate: (name: string, title: string) => `⚪ ${name} — ${title} (вже є)`,
  mcSyncSummary: (added: number, existing: number) =>
    `Додано: ${added}, вже було: ${existing}.`,
  noResponsiblePersons: "Відповідальних ще немає.",
  delRespPickerTitle: "Кого видалити з відповідальних?",
  confirmDelResp: (name: string, title: string) => `Видалити ${name} з «${title}»?`,
  delRespGone: "Цей запис уже видалено.",
```

(`delRespUsage` and `respNotFoundAdmin` are removed — grep-confirmed in the design spec as used only by the old `/delresp` handler being replaced in this task.)

- [ ] **Step 3: Update the `./responsible` import in `src/bot.ts`**

Replace:

```ts
import {
  addResponsible,
  findResponsibleByTelegramId,
  linkResponsibleRows,
  loadResponsible,
  removeResponsible,
  searchResponsibleByName,
} from "./responsible";
```

with:

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

- [ ] **Step 4: Replace the `delresp` handler in `src/bot.ts`**

Replace lines 405-417:

```ts
bot.command("delresp", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.delRespUsage);
  const [mcId, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const ok = await removeResponsible(mcId, name);
  if (!ok) return ctx.reply(M.respNotFoundAdmin(name, mcId));
  const mcs = await loadMasterclasses();
  const title = mcs.find((m) => m.id === mcId)?.title ?? `МК ${mcId}`;
  return ctx.reply(M.respRemoved(name, title));
});
```

with:

```ts
async function buildDelRespPicker(): Promise<{ text: string; kb: InlineKeyboard } | null> {
  const [{ responsible }, mcs] = await Promise.all([loadResponsible(), loadMasterclasses()]);
  if (responsible.length === 0) return null;
  const kb = new InlineKeyboard();
  const knownIds = new Set(mcs.map((m) => m.id));
  const groups = [
    ...mcs.map((mc) => ({ title: mc.title, rows: responsible.filter((r) => r.mcId === mc.id) })),
    ...[...new Set(responsible.filter((r) => !knownIds.has(r.mcId)).map((r) => r.mcId))].map(
      (mcId) => ({ title: `МК ${mcId}`, rows: responsible.filter((r) => r.mcId === mcId) }),
    ),
  ];
  for (const g of groups) {
    if (g.rows.length === 0) continue;
    kb.text(`— ${g.title} —`, "mcnoop").row();
    for (const r of g.rows) kb.text(`❌ ${r.name}`, `delresp:${r.rowIndex}`).row();
  }
  return { text: M.delRespPickerTitle, kb };
}

bot.command("delresp", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const picker = await buildDelRespPicker();
  if (!picker) return ctx.reply(M.noResponsiblePersons);
  return ctx.reply(picker.text, { reply_markup: picker.kb });
});

bot.callbackQuery(/^delresp:(\d+)$/, async (ctx) => {
  const rowIndex = Number(ctx.match[1]);
  const { responsible } = await loadResponsible();
  const row = responsible.find((r) => r.rowIndex === rowIndex);
  await ctx.answerCallbackQuery();
  if (!row) return ctx.editMessageText(M.delRespGone);
  const mcs = await loadMasterclasses();
  const title = mcs.find((m) => m.id === row.mcId)?.title ?? `МК ${row.mcId}`;
  const kb = new InlineKeyboard()
    .text("✅ Так, видалити", `delrespyes:${rowIndex}`)
    .text("↩️ Скасувати", "delrespcancel");
  return ctx.editMessageText(M.confirmDelResp(row.name, title), { reply_markup: kb });
});

bot.callbackQuery(/^delrespyes:(\d+)$/, async (ctx) => {
  const rowIndex = Number(ctx.match[1]);
  const { responsible } = await loadResponsible();
  const row = responsible.find((r) => r.rowIndex === rowIndex);
  await ctx.answerCallbackQuery();
  if (!row) return ctx.editMessageText(M.delRespGone);
  await removeResponsibleByRow(rowIndex);
  const mcs = await loadMasterclasses();
  const title = mcs.find((m) => m.id === row.mcId)?.title ?? `МК ${row.mcId}`;
  return ctx.editMessageText(M.respRemoved(row.name, title));
});

bot.callbackQuery("delrespcancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  const picker = await buildDelRespPicker();
  if (!picker) return ctx.editMessageText(M.noResponsiblePersons);
  return ctx.editMessageText(picker.text, { reply_markup: picker.kb });
});
```

- [ ] **Step 5: Add `/delresp` to the admin command menu in `src/commands.ts`**

Replace (as it stands after Task 1 Step 5):

```ts
const ADMIN_COMMANDS = [
  ...LEADER_COMMANDS,
  { command: "listleaders", description: "Список лідерів" },
  { command: "syncresp", description: "Синхронізувати відповідальних" },
];
```

with:

```ts
const ADMIN_COMMANDS = [
  ...LEADER_COMMANDS,
  { command: "listleaders", description: "Список лідерів" },
  { command: "syncresp", description: "Синхронізувати відповідальних" },
  { command: "delresp", description: "Видалити відповідального" },
];
```

- [ ] **Step 6: Verify types**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Verify no stale references remain**

Run: `grep -rn "removeResponsible\b\|delRespUsage\|respNotFoundAdmin" src/`
Expected: no output. (`removeResponsible\b` must not match `removeResponsibleByRow` — the word boundary in the pattern already excludes it.)

- [ ] **Step 8: Commit**

```bash
git add src/responsible.ts src/messages.ts src/bot.ts src/commands.ts
git commit -m "feat: replace /delresp typed-name form with a button picker"
```

---

## Self-Review

**Spec coverage:**
- `splitResponsibleNames` conjunction/comma splitting → Task 1 Step 1 ✓
- `/syncresp` additive-only loop over catalog, reusing `addResponsible`'s duplicate check, itemized report + summary → Task 1 Step 4 ✓
- Catalog-unavailable edge case → Task 1 Step 4 (`mcs.length === 0`) ✓
- `/syncresp` in `ADMIN_COMMANDS` (zero-arg convention) → Task 1 Step 5 ✓
- `removeResponsibleByRow` replacing name-based removal → Task 2 Step 1 ✓
- `/delresp` grouped picker (catalog order + fallback `МК {id}` group for orphaned rows), reusing `mcnoop` → Task 2 Step 4 (`buildDelRespPicker`) ✓
- Select → confirm → delete flow with race-safe "already gone" handling → Task 2 Step 4 (`delresp:`, `delrespyes:` handlers) ✓
- Cancel restores the full picker from fresh data → Task 2 Step 4 (`delrespcancel`) ✓
- Empty-list edge case (`M.noResponsiblePersons`) → Task 2 Step 4 (both the command handler and `delrespcancel`) ✓
- `/delresp` in `ADMIN_COMMANDS` → Task 2 Step 5 ✓
- Removed messages (`delRespUsage`, `respNotFoundAdmin`) and removed function (`removeResponsible`) cleaned up with grep verification → Task 2 Steps 2, 7 ✓

**Placeholder scan:** none — every step has complete code and every verify step has an exact command with expected output.

**Type consistency:** `splitResponsibleNames(text: string): string[]` (Task 1 Step 1) matches its call site in Task 1 Step 4. `removeResponsibleByRow(rowIndex: number): Promise<void>` (Task 2 Step 1) matches its import (Step 3) and call site (Step 4). `buildDelRespPicker(): Promise<{ text: string; kb: InlineKeyboard } | null>` is defined and consumed only within Task 2 Step 4 — both the command handler and `delrespcancel` destructure `{ text, kb }` consistently. `Responsible.rowIndex`/`.mcId`/`.name` (existing type, unchanged) match every access in the new picker/callback code.
