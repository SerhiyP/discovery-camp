# /delresp Button Picker — Design

**Date:** 2026-07-04
**Status:** Approved for planning

## Goal

`/delresp <ID майстер-класу> <Прізвище та ім'я>` currently requires the admin to type the
exact normalized name of the responsible person to remove. Replace it with a button-based
picker: `/delresp` (no arguments) lists everyone in `MCResponsible`, grouped by
masterclass, as tappable buttons, with a confirm step before actually removing a row.

This establishes a pattern — button pickers over typed exact names for admin
delete-by-name commands — that should be reused if `/removeleader`/`/removeadmin` are
revisited later (not part of this change).

## Behavior

1. Admin/superadmin only, same gate as today (`isAdmin(ctx.from?.id, admins)`).
2. Takes no arguments — the old `<mcId> <ПІБ>` form is removed entirely.
3. Loads `loadResponsible()` and `loadMasterclasses()`. If there are zero responsible rows
   at all, reply `M.noResponsiblePersons` and stop.
4. Reply with one message: header `M.delRespPickerTitle`, and an `InlineKeyboard` grouped
   by masterclass:
   - For each catalog masterclass with ≥1 responsible row, an inert header row
     `— {title} —` — reusing the `mcnoop` no-op callback already registered for the
     combined masterclass list (`src/bot.ts`, from the mc-list-ux branch) — then one
     `❌ {name}` button per person, callback `delresp:<rowIndex>`.
   - Any responsible row whose `mcId` isn't found in the catalog gets its own group with
     fallback title `МК {mcId}` (mirrors the existing fallback used by `/addresp`).
5. Tapping `delresp:<rowIndex>` edits the message to a single confirmation for just that
   person: `M.confirmDelResp(name, title)` → `"Видалити {name} з «{title}»?"`, with two
   buttons: `✅ Так, видалити` (`delrespyes:<rowIndex>`) and `↩️ Скасувати`
   (`delrespcancel`).
6. `delrespyes:<rowIndex>`: re-loads responsible rows, finds the row by `rowIndex`.
   - Not found (already removed, e.g. two admins tapping concurrently) → edit message to
     `M.delRespGone`.
   - Found → `removeResponsibleByRow(rowIndex)`, look up the masterclass title, edit the
     message to `M.respRemoved(name, title)` (existing message, reused — same semantic
     action as before, just a different trigger). No keyboard afterward. To remove
     someone else, the admin runs `/delresp` again.
7. `delrespcancel`: rebuilds and re-renders the full picker from fresh data (same logic as
   step 4, factored into a shared function so both the command handler and this callback
   call it).

Example first message:

```
Кого видалити з відповідальних?

— Медична допомога —
❌ Лєна Бабій
❌ Інна Коляденко
— Кулінарія —
❌ Катерина Петренко
— Рукоділля —
❌ Лєна Кротик
```

Tapping `❌ Лєна Бабій` edits it to:

```
Видалити Лєна Бабій з «Медична допомога»?

[✅ Так, видалити]  [↩️ Скасувати]
```

## `src/responsible.ts`

Replace the name-based `removeResponsible(mcId, name)` (grep-confirmed used only by the
old `/delresp` handler, so safe to remove) with a row-based version, consistent with how
`link_resp:<rowIndex>` already addresses rows elsewhere in the codebase:

```ts
export async function removeResponsibleByRow(rowIndex: number): Promise<void> {
  await clearRow(config.responsibleTab, rowIndex);
}
```

`loadResponsible()` and its `Responsible` interface (`rowIndex`, `mcId`, `name`,
`telegramId`, `addedAt`) are unchanged and already provide everything the picker needs.

## `src/bot.ts`

Replace the current `delresp` handler with:

```ts
async function buildDelRespPicker(): Promise<
  { text: string; kb: InlineKeyboard } | null
> {
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

## `src/messages.ts`

Remove `delRespUsage` and `respNotFoundAdmin` (grep-confirmed: each used only in the old
`/delresp` handler being replaced). Add:

```ts
noResponsiblePersons: "Відповідальних ще немає.",
delRespPickerTitle: "Кого видалити з відповідальних?",
confirmDelResp: (name: string, title: string) => `Видалити ${name} з «${title}»?`,
delRespGone: "Цей запис уже видалено.",
```

`respRemoved` (existing) is reused unchanged for the post-deletion confirmation.

## `src/commands.ts`

`/delresp` is now zero-arg, so — per the existing convention ("only zero-arg commands
belong in the slash menu") — it joins `/syncresp` in `ADMIN_COMMANDS`:

```ts
const ADMIN_COMMANDS = [
  ...LEADER_COMMANDS,
  { command: "listleaders", description: "Список лідерів" },
  { command: "syncresp", description: "Синхронізувати відповідальних" },
  { command: "delresp", description: "Видалити відповідального" },
];
```

`/addresp` still takes arguments and stays out, unchanged.

## Out of scope

- Applying this button-picker pattern to `/removeleader`/`/removeadmin` — noted as a
  convention for later, not built here.
- Removing more than one person per `/delresp` invocation without re-running the command
  (rejected during design — see "After delete" decision below).
- Any change to `/addresp` or `addResponsible`.

## Edge cases

- Zero responsible rows at all → `M.noResponsiblePersons`, no keyboard.
- Concurrent deletion (two admins, or admin double-taps) → the row is gone by the time
  `delrespyes:` runs → `M.delRespGone` instead of a crash or false success.
- Responsible row referencing an MC ID not in the catalog → grouped under a fallback
  `МК {mcId}` header, matching the existing fallback pattern.
- After confirming a deletion, the message shows plain text with no keyboard — removing
  another person requires re-running `/delresp` (chosen deliberately over refreshing the
  list in place, to avoid rebuilding the grouped list as live state mid-session).

## Verification

`npm run typecheck` must pass; behavior confirmed after `npx vercel --prod` (no tests, no
local dev server in this repo, per existing convention; `npm run set-webhook` isn't needed
since the webhook already points at the stable production domain, which doesn't change
between deploys) — run `/delresp`, tap through a removal and a cancel, and confirm the
sheet's `MCResponsible` row is actually cleared.
