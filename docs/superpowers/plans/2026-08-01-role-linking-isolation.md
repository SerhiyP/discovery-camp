# Command-Gated Leader/Responsible Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make leader and responsible linking opt-in via `/leader <ПІБ>` and `/responsible <ПІБ>`, so a plain text message only ever searches the Visitors table.

**Architecture:** Each linking attempt becomes one self-contained command carrying the name as its argument, so nothing has to be remembered between messages (Vercel serverless keeps no session state). Two `bot.command` handlers each do guard → search-one-table → confirm-button, reusing the existing `link_leader:` / `link_resp:` callbacks untouched. The generic `bot.on("message:text")` handler only loses code.

**Tech Stack:** TypeScript, grammY, Google Sheets API, Vercel serverless.

**Spec:** `docs/superpowers/specs/2026-08-01-role-linking-isolation-design.md`

## Global Constraints

- **No test framework exists in this repo, by design.** `CLAUDE.md` states: "There are no tests and no local dev server — the bot runs exclusively as a Vercel serverless function." Do NOT add vitest/jest — it is out of scope for this change. Every task's automated gate is `npm run typecheck` plus the grep assertions written into each task. Behavioral confirmation happens once, manually, in Task 5.
- **All user-facing strings live in `src/messages.ts`'s `M` object.** Never inline a Ukrainian string in `src/bot.ts`.
- **Ukrainian copy is fixed by the spec.** Copy the strings in Task 1 verbatim, including emoji, the `’`-free apostrophe style (`ім'я` uses U+0027), and line breaks.
- **Do not touch** `src/leaders.ts`, `src/responsible.ts`, `src/checkin.ts`, `src/keyboards.ts`, or `src/commands.ts`. Their search/link primitives are already correct, and neither command gets a slash-menu entry.
- **Do not touch** the `link_leader:` (`src/bot.ts:238-273`) or `link_resp:` (`src/bot.ts:275-302`) callback handlers.
- **Commit after every task**, using the message given in that task's final step.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/messages.ts` | Modify | Reword `leaderPrompt`; add `respPrompt`, `respAlreadyLinked` |
| `src/bot.ts` | Modify | `/leader` takes an argument; new `/responsible`; strip role search from the text handler |
| `README.md` | Modify | Document both commands; drop the two "може бути одночасно" notes |
| `CLAUDE.md` | Modify | Role-system + name-search notes reflect command gating |

Task order matters: Task 1 defines the strings Tasks 2–4 consume, and Task 4 depends on `respAlreadyLinked` existing. Tasks 2 and 3 are independent of each other.

---

### Task 1: Message strings

**Files:**
- Modify: `src/messages.ts:88-106`

**Interfaces:**
- Consumes: nothing.
- Produces: `M.leaderPrompt: string` (reworded), `M.respPrompt: string` (new), `M.respAlreadyLinked: (name: string) => string` (new). Tasks 2, 3, and 4 all reference these.

- [ ] **Step 1: Reword `M.leaderPrompt`**

The current wording tells the user to write their bare name, which after this change would dead-end in the visitor search. Replace `src/messages.ts:89-90`:

```ts
  leaderPrompt:
    "Це вхід для лідерів команд. Напишіть своє прізвище та ім'я — так, як вас зареєстрував адміністратор.",
```

with:

```ts
  leaderPrompt:
    "Це вхід для лідерів команд. Надішліть команду разом зі своїм прізвищем та іменем — так, як вас зареєстрував адміністратор:\n\n/leader Прізвище Ім'я",
```

- [ ] **Step 2: Add the two responsible strings**

In the `// Responsible check-in` block, insert `respPrompt` and `respAlreadyLinked` immediately before the existing `confirmResp` (`src/messages.ts:100-102`), so the block reads:

```ts
  // Responsible check-in
  respPrompt:
    "Це вхід для відповідальних за майстер-класи. Надішліть команду разом зі своїм прізвищем та іменем — так, як вас зареєстрував адміністратор:\n\n/responsible Прізвище Ім'я",
  respAlreadyLinked: (name: string) =>
    `Ви вже підключені як відповідальний за майстер-клас (${name}) ✅`,
  confirmResp: (name: string) =>
    `Це ви — відповідальний за майстер-клас?\n${name}\n\nНатисніть, щоб підтвердитись 👇`,
```

- [ ] **Step 3: Verify the strings exist and typecheck passes**

Run:

```bash
cd /Users/serhii/projects/discovery-camp
grep -c "respPrompt\|respAlreadyLinked" src/messages.ts
grep -c "/leader Прізвище Ім'я" src/messages.ts
npm run typecheck
```

Expected: first grep prints `2`, second prints `1`, typecheck exits 0 with no output beyond the npm banner.

- [ ] **Step 4: Commit**

```bash
git add src/messages.ts
git commit -m "feat(messages): usage-hint prompts for /leader and /responsible"
```

---

### Task 2: `/leader <ПІБ>`

**Files:**
- Modify: `src/bot.ts:152-159`

**Interfaces:**
- Consumes: `M.leaderPrompt` (Task 1). Existing: `loadLeaders()`, `findLeadersByTelegramId(leaders, id): Leader[]`, `searchLeaderByName(leaders, query): Leader[]` (returns only rows with an empty `telegramId`), `Leader.rowIndex/name/team`, `M.leaderAlreadyLinked`, `M.leaderNotFound`, `M.confirmLeader`, `M.chooseYourself`, `InlineKeyboard` (already imported at `src/bot.ts:1`).
- Produces: `link_leader:<rowIndex>` callback data — already handled at `src/bot.ts:238-273`, unchanged.

- [ ] **Step 1: Replace the `/leader` handler**

Replace the whole handler at `src/bot.ts:152-159`:

```ts
bot.command("leader", async (ctx) => {
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length > 0) {
    return ctx.reply(M.leaderAlreadyLinked(mine[0].name, mine[0].team));
  }
  return ctx.reply(M.leaderPrompt);
});
```

with:

```ts
// Leader linking is command-gated: the name arrives as the command argument, so a plain
// text message never searches the Leaders table. See docs/superpowers/specs/2026-08-01-*.
bot.command("leader", async (ctx) => {
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length > 0) {
    return ctx.reply(M.leaderAlreadyLinked(mine[0].name, mine[0].team));
  }

  const query = ctx.match.trim();
  if (!query) return ctx.reply(M.leaderPrompt);

  // searchLeaderByName only returns rows that nobody has claimed yet.
  const matches = searchLeaderByName(leaders, query);
  if (matches.length === 0) return ctx.reply(M.leaderNotFound);

  const kb = new InlineKeyboard();
  if (matches.length === 1) {
    const l = matches[0];
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
    return ctx.reply(M.confirmLeader(l.name, l.team), { reply_markup: kb });
  }
  for (const l of matches) {
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
  }
  return ctx.reply(M.chooseYourself, { reply_markup: kb });
});
```

- [ ] **Step 2: Verify it typechecks**

Run:

```bash
cd /Users/serhii/projects/discovery-camp && npm run typecheck
```

Expected: exits 0. A `Property 'trim' does not exist` error here would mean the handler was pasted outside `bot.command`, where `ctx.match` is not a string — re-check placement.

- [ ] **Step 3: Verify the guard order structurally**

The already-linked check must come before the empty-argument check, so a linked leader sending bare `/leader` gets `leaderAlreadyLinked`, not the prompt.

Run:

```bash
cd /Users/serhii/projects/discovery-camp
awk '/bot.command\("leader"/,/^}\);/' src/bot.ts | grep -n "leaderAlreadyLinked\|leaderPrompt\|leaderNotFound"
```

Expected: three lines, in this order — `leaderAlreadyLinked`, then `leaderPrompt`, then `leaderNotFound`.

- [ ] **Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "feat(leader): take name as /leader <ПІБ> argument"
```

---

### Task 3: `/responsible <ПІБ>`

**Files:**
- Modify: `src/bot.ts` — insert directly after the `/leader` handler from Task 2

**Interfaces:**
- Consumes: `M.respPrompt`, `M.respAlreadyLinked` (Task 1). Existing: `loadResponsible()` (returns `{ responsible, cols }`), `findResponsibleByTelegramId(list, id): Responsible[]`, `searchResponsibleByName(list, query): Responsible[]`, `Responsible.rowIndex/name/mcId`, `M.respNotFound`, `M.confirmResp`, `M.chooseYourself`. All are already imported at `src/bot.ts:45-52`.
- Produces: `link_resp:<rowIndex>` callback data — already handled at `src/bot.ts:275-302`, unchanged.

- [ ] **Step 1: Add the `/responsible` handler**

Insert immediately after the `/leader` handler's closing `});`:

```ts
// Mirrors /leader. One person may run several masterclasses (several MCResponsible rows);
// the dedup below shows one button per person, and link_resp: links all of their rows.
bot.command("responsible", async (ctx) => {
  const sheet = await loadResponsible();
  const mine = findResponsibleByTelegramId(sheet.responsible, ctx.from!.id);
  if (mine.length > 0) return ctx.reply(M.respAlreadyLinked(mine[0].name));

  const query = ctx.match.trim();
  if (!query) return ctx.reply(M.respPrompt);

  const rows = searchResponsibleByName(sheet.responsible, query);
  const matches = [...new Map(rows.map((r) => [r.name.toLowerCase(), r])).values()];
  if (matches.length === 0) return ctx.reply(M.respNotFound);

  const kb = new InlineKeyboard();
  if (matches.length === 1) {
    const r = matches[0];
    kb.text(`🎨 ${r.name}`, `link_resp:${r.rowIndex}`).row();
    return ctx.reply(M.confirmResp(r.name), { reply_markup: kb });
  }
  for (const r of matches) {
    kb.text(`🎨 ${r.name}`, `link_resp:${r.rowIndex}`).row();
  }
  return ctx.reply(M.chooseYourself, { reply_markup: kb });
});
```

- [ ] **Step 2: Verify it typechecks**

Run:

```bash
cd /Users/serhii/projects/discovery-camp && npm run typecheck
```

Expected: exits 0.

- [ ] **Step 3: Verify the command is registered and stays out of the slash menu**

Run:

```bash
cd /Users/serhii/projects/discovery-camp
grep -c 'bot.command("responsible"' src/bot.ts
grep -c "responsible" src/commands.ts
```

Expected: first prints `1`; second prints `0` — `/responsible` is typed-only, matching how `/leader` is deliberately absent from the menus.

- [ ] **Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "feat(responsible): add /responsible <ПІБ> linking command"
```

---

### Task 4: Strip role search from the generic text handler

**Files:**
- Modify: `src/bot.ts` — the `bot.on("message:text", ...)` handler near the end of the file

**Interfaces:**
- Consumes: `M.respAlreadyLinked` (Task 1); existing `M.leaderAlreadyLinked`, `M.alreadyLinked`, `M.notFound`, `M.confirmOne`, `M.chooseYourself`.
- Produces: nothing new. `searchLeaderByName` and `searchResponsibleByName` remain imported — Tasks 2 and 3 are now their only callers.

- [ ] **Step 1: Replace the handler body**

The handler was at `src/bot.ts:916-965` before Tasks 2–3 added lines, so locate it by searching for `bot.on("message:text"` rather than by line number. It is the last handler before the `// Set scoped command menus for all known privileged users on cold start.` block. Replace the whole handler with:

```ts
bot.on("message:text", async (ctx) => {
  const [sheet, leaderSheet, respSheet] = await Promise.all([
    loadVisitors(),
    loadLeaders(),
    loadResponsible(),
  ]);

  const meVisitor = findByTelegramId(sheet.visitors, ctx.from.id);
  const meLeader = findLeadersByTelegramId(leaderSheet.leaders, ctx.from.id);
  const meResponsible = findResponsibleByTelegramId(respSheet.responsible, ctx.from.id);

  // Only visitors are searched here — leader/responsible linking is command-gated behind
  // /leader and /responsible, so a typed name can never offer someone else's role.
  const visitorMatches = meVisitor ? [] : searchByName(sheet.visitors, ctx.message.text);

  if (visitorMatches.length === 0) {
    if (meLeader.length > 0)
      return ctx.reply(M.leaderAlreadyLinked(meLeader[0].name, meLeader[0].team));
    if (meResponsible.length > 0) return ctx.reply(M.respAlreadyLinked(meResponsible[0].name));
    if (meVisitor) return ctx.reply(M.alreadyLinked(meVisitor.name));
    return ctx.reply(M.notFound);
  }

  const kb = new InlineKeyboard();
  if (visitorMatches.length === 1) {
    kb.text(visitorMatches[0].name, `link:${visitorMatches[0].rowIndex}`).row();
    return ctx.reply(M.confirmOne, { reply_markup: kb });
  }
  for (const v of visitorMatches) kb.text(v.name, `link:${v.rowIndex}`).row();
  return ctx.reply(M.chooseYourself, { reply_markup: kb });
});
```

Leaders and responsible rows are still loaded, but now only to answer "you are already linked as X" when no visitor matches.

- [ ] **Step 2: Verify the role searches are gone from the text handler**

Run:

```bash
cd /Users/serhii/projects/discovery-camp
awk '/bot.on\("message:text"/,/^}\);/' src/bot.ts | grep -c "searchLeaderByName\|searchResponsibleByName\|link_leader:\|link_resp:"
```

Expected: `0`. Any other number means role searching or role buttons survived in the text handler — the core bug this change exists to fix.

- [ ] **Step 3: Verify both searches still have exactly one caller each, and typecheck**

Run:

```bash
cd /Users/serhii/projects/discovery-camp
grep -c "searchLeaderByName" src/bot.ts
grep -c "searchResponsibleByName" src/bot.ts
npm run typecheck
```

Expected: each grep prints `2` (one import line + one call site in the Task 2/3 command). Typecheck exits 0 — an unused-import error here would mean a command handler is missing.

- [ ] **Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "fix(checkin): plain name search no longer offers leader/responsible roles"
```

---

### Task 5: Documentation + manual verification

**Files:**
- Modify: `README.md:27-49`
- Modify: `CLAUDE.md:67`, `CLAUDE.md:85`

**Interfaces:**
- Consumes: the finished behavior from Tasks 1–4.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Update the README leader section**

Replace `README.md:30-31`:

```markdown
2. Лідер відкриває бота і натискає `/leader`.
3. Пише своє ПІБ → підтверджує → підключається до команди.
```

with:

```markdown
2. Лідер відкриває бота і надсилає `/leader <Прізвище Ім'я>` — так, як його зареєстрував адмін.
3. Підтверджує себе кнопкою → підключається до команди.
```

- [ ] **Step 2: Replace the README leader note**

Replace `README.md:37`:

```markdown
> Лідер може бути одночасно відвідувачем. Бот покаже обидва варіанти при введенні ПІБ.
```

with:

```markdown
> Роль лідера підключається **тільки** командою `/leader`. Якщо просто написати ПІБ, бот шукає лише серед відвідувачів — це захищає лідерів від того, щоб хтось випадково чи навмисно зайняв їхнє ім'я.
```

- [ ] **Step 3: Update the README responsible section**

Replace `README.md:44`:

```markdown
2. Відповідальний пише своє ПІБ боту → підтверджує → підключається одразу до всіх майстер-класів, закріплених на це ім'я.
```

with:

```markdown
2. Відповідальний надсилає `/responsible <Прізвище Ім'я>` → підтверджує себе кнопкою → підключається одразу до всіх майстер-класів, закріплених на це ім'я.
```

- [ ] **Step 4: Replace the README responsible note**

Replace `README.md:49`:

```markdown
> Відповідальний може бути одночасно лідером команди і/або відвідувачем — клавіатури об'єднуються.
```

with:

```markdown
> Роль відповідального підключається **тільки** командою `/responsible`. Якщо одна людина має кілька ролей, кожну треба підключити її власною командою — бот більше не пропонує їх автоматично. Клавіатури підключених ролей об'єднуються.
```

- [ ] **Step 5: Update `CLAUDE.md`**

Replace the tail of `CLAUDE.md:67` — the sentence `Independent of the leader role; a person can hold both.` — with:

```markdown
Independent of the leader role; a person can hold both, but each role must be claimed through its own command (`/leader`, `/responsible`) — the bot never offers them together.
```

Then append to `CLAUDE.md:85` (the **Name search** bullet):

```markdown
Only the Visitors sheet is searched this way — leader and responsible linking is command-gated behind `/leader <ПІБ>` and `/responsible <ПІБ>` so a typed name can never surface someone else's role.
```

- [ ] **Step 6: Verify the stale notes are gone**

Run:

```bash
cd /Users/serhii/projects/discovery-camp
grep -c "може бути одночасно" README.md
grep -c "responsible" README.md
npm run typecheck
```

Expected: first prints `0` (both old notes replaced); second prints at least `1`; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: command-gated leader/responsible linking"
```

- [ ] **Step 8: Deploy and verify manually**

This is the only behavioral verification in the plan — there is no local dev server, so it must happen against production. Ask the user before deploying; do not run `vercel` unprompted.

```bash
cd /Users/serhii/projects/discovery-camp && npx vercel --prod
```

`npm run set-webhook` is only needed if the deployment URL changed.

Then, in Telegram, confirm each of these:

1. From an unlinked account, type a **known leader's name** as a plain message → visitor results or `M.notFound`. **No `👑` button appears.** (This is the regression this whole change exists to prevent.)
2. Bare `/leader` → usage hint showing `/leader Прізвище Ім'я`.
3. `/leader <that leader's name>` → `👑` confirm button → tap → linked, leader keyboard appears.
4. `/responsible <a responsible person's name>` → `🎨` confirm button → tap → linked, responsible keyboard appears.
5. Re-run `/leader` while linked → `M.leaderAlreadyLinked`. Re-run `/responsible` while linked → `M.respAlreadyLinked`.
6. From a **second** account, `/leader <same now-claimed name>` → `M.leaderNotFound`.

- [ ] **Step 9: Report results honestly**

State which of the six checks passed and which did not, quoting what the bot actually replied. Do not claim the change is verified if any step was skipped — say which and why.

---

## Out of scope

- Adding a test framework (see Global Constraints).
- Any identity verification beyond the existing "row already taken" guard — explicitly rejected during design.
- Deleting the `Leaders` sheet's stray label row (`№ групи | Колір браслетів | Наставники`). That is a manual spreadsheet edit the user is doing themselves; no code guards against it.
- Changing `roleKeyboard()` — every role keeps the base visitor buttons.
