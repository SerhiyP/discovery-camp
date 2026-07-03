# Sync Responsible Persons from Catalog — Design

**Date:** 2026-07-04
**Status:** Approved for planning

## Goal

The masterclass catalog (`5.Майстер-класи 2026` in the grid spreadsheet) already lists a
`Відповідальний` column per masterclass, e.g. `Лєна Бабій і Інна Коляденко` for MC 1. The
bot already reads this into `Masterclass.responsible` (`src/masterclasses.ts`) but only as
display text — the actual `MCResponsible` linking rows are added one person at a time via
`/addresp <mcId> <ПІБ>`. For 8+ masterclasses, several with two people, this is repetitive
manual typing that just duplicates data the organizers already maintain.

Add `/syncresp` — an admin/superadmin command, no arguments — that reads the catalog and
bulk-creates the missing `MCResponsible` rows in one pass.

## Behavior

1. Admin/superadmin only, same gate as `/addresp`/`/delresp` (`isAdmin(ctx.from?.id, admins)`).
2. Takes no arguments — always syncs the entire catalog (it's ~8 masterclasses; there's no
   real case for scoping to one).
3. Loads the catalog via `loadMasterclasses()`. If it's empty (grid spreadsheet unset or
   unreadable — same condition `/addresp` already hits via `mcNotFoundAdmin`, but here
   there's no single MC to blame), reply `M.mcCatalogUnavailable` and stop.
4. For each masterclass in catalog order, split its `responsible` text into individual
   names (see "Name splitting" below) and call the existing `addResponsible(mc.id, name)`
   for each — reusing its built-in duplicate check (`mcId` + normalized name), so no new
   dedup logic is needed.
5. Reply with **one itemized message**: a header, one line per name (`✅` if newly added,
   `⚪ ... (вже є)` if it already existed), then a totals line. With realistically ~10-14
   names total this stays far under Telegram's 4096-char message limit — no pagination.
6. **Additive only.** Never removes a `MCResponsible` row. If the catalog cell no longer
   lists someone who's already linked, that person keeps their access — unlinking a
   checked-in responsible person because of a catalog edit/typo would be worse than
   leaving a stale row, and `/delresp` already exists for intentional removal.

Example reply:

```
Синхронізація відповідальних:

✅ Лєна Бабій — Медична допомога
✅ Інна Коляденко — Медична допомога
⚪ Катерина Петренко — Кулінарія (вже є)
✅ Лєна Кротик — Рукоділля

Додано: 3, вже було: 1.
```

## Name splitting

New exported function in `src/masterclasses.ts` (colocated with `loadMasterclasses`, since
it's interpreting catalog text — a masterclasses concern, not a responsible-role concern):

```ts
export function splitResponsibleNames(text: string): string[] {
  return text
    .split(/\s+(?:і|та)\s+|\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}
```

- Splits on the Ukrainian conjunctions ` і ` / ` та ` (whitespace required on both sides,
  so it won't false-match inside a name like "Марія") or a comma with optional surrounding
  whitespace.
- A blank cell (`""`) or one with no delimiter yields `[]` or a single name respectively —
  no special-casing needed either way.
- No further normalization here — `addResponsible`'s existing `normalizeStr` handles
  case/apostrophe/whitespace differences when checking for duplicates.

## Messages (`src/messages.ts`)

New entries, distinct from `/addresp`'s existing `respAdded`/`respDuplicate` (different UX
context: a bulk report vs. a single-action confirmation, so separate wording is
appropriate rather than reusing those):

```ts
mcCatalogUnavailable: "Каталог майстер-класів недоступний.",
mcSyncTitle: "Синхронізація відповідальних:",
mcSyncAdded: (name: string, title: string) => `✅ ${name} — ${title}`,
mcSyncDuplicate: (name: string, title: string) => `⚪ ${name} — ${title} (вже є)`,
mcSyncSummary: (added: number, existing: number) =>
  `Додано: ${added}, вже було: ${existing}.`,
```

## Command (`src/bot.ts`)

Added directly after the existing `delresp` handler:

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

`splitResponsibleNames` is imported from `./masterclasses` alongside the existing
`loadMasterclasses` import.

## `src/commands.ts`

Unlike `/addresp`/`/delresp` (excluded because they take arguments), `/syncresp` takes
none — per the existing convention ("only zero-arg commands belong in the slash menu"),
it's added to the scoped admin menu:

```ts
const ADMIN_COMMANDS = [
  ...LEADER_COMMANDS,
  { command: "listleaders", description: "Список лідерів" },
  { command: "syncresp", description: "Синхронізувати відповідальних" },
];
```

## Out of scope

- Removing stale `MCResponsible` rows no longer present in the catalog.
- A per-MC argument (`/syncresp 3`) — catalog is small enough that whole-catalog sync is
  always the right granularity.
- New name-normalization logic beyond what `addResponsible` already does.

## Edge cases

- Catalog unreadable (`GRID_SHEET_ID` unset, header row missing) → `loadMasterclasses()`
  returns `[]` → `M.mcCatalogUnavailable`, no report sent.
- A masterclass with a blank/missing `Відповідальний` cell → contributes zero lines to the
  report (not an error, not itemized as "skipped" — YAGNI, the report already shows what
  *did* happen).
- Running `/syncresp` twice in a row → second run reports everything as `⚪ ... (вже є)`,
  `added: 0` — safe to re-run any time, e.g. after the organizers edit the catalog.
- A name appearing under two different masterclasses (e.g. one person running two MCs) →
  each is a distinct `(mcId, name)` pair in `MCResponsible`, both get added independently,
  matching the existing "one person may have several rows" design from the original
  masterclasses spec.

## Verification

`npm run typecheck` must pass; behavior confirmed after `npx vercel --prod` (no tests, no
local dev server in this repo, per existing convention; `npm run set-webhook` isn't needed
since the webhook already points at the stable production domain, which doesn't change
between deploys) — run `/syncresp` against the real catalog and check the reported
names/titles against the sheet.
