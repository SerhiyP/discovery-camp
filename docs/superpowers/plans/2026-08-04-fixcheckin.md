# /fixcheckin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a `/fixcheckin <ПІБ | Telegram ID>` command that releases a wrongly-claimed
visitor row — showing who claimed it, with a tappable link to that account — so the right person can
check in normally.

**Architecture:** A single new Mongo write (`releaseCheckInMongo`, the exact inverse of
`linkAndCheckInMongo`) plus a three-callback picker → confirm → release flow in `src/bot.ts`, modelled
on the existing `/delresp` button picker. The account holding a row is identified at render time via
`bot.api.getChat`, so nothing new is stored and check-ins already in Mongo are covered.

**Tech Stack:** TypeScript 5.6, grammY 1.30, mongodb driver 7.5, Vercel serverless. No test framework
exists in this repo — every task is verified with `npm run typecheck` plus a scripted manual check
against the long-polling dev bot (`npm run dev`).

**Spec:** `docs/superpowers/specs/2026-08-04-fix-checkin-design.md`

## Global Constraints

- **Mongo is the only write target.** The sheet's `Checked in` / `Telegram ID` columns have not been
  written since the 2026-08-03 migration; do not start writing them.
- **`doctorStatus` is never cleared** by this feature. See the spec's "Design notes".
- **Nothing expensive at module scope** (`CLAUDE.md`) — every new symbol is a function or a plain
  constant, never a call.
- **All callback handlers answer through `safeAnswer()`**, never `ctx.answerCallbackQuery` directly,
  and never let the answer gate a write. Anything the user must read is a real message.
- **Every Mongo-backed handler is wrapped in `mongoGuarded`** so an outage replies
  «Тимчасова помилка» instead of a 500 that Telegram redelivers.
- **`src/messages.ts` imports nothing.** Keep it that way: new message helpers take primitives, not
  domain objects.
- **All user-facing strings are Ukrainian and live in `M`** (`src/messages.ts`). No inline literals in
  `src/bot.ts` except inline-button labels, which follow the existing `/delresp` precedent
  (`"✅ Так, видалити"` / `"↩️ Скасувати"` are literals there).
- **Sheets reads are quota-bound.** This feature must not read the Visitors tab: all lookups go
  through the Mongo mirror.
- **Commit after every task**, using the message given in the task's final step.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/visitor-store.ts` | Modify | Add `releaseCheckInMongo` and `findVisitorByRowMongo` beside `linkAndCheckInMongo`. Data layer only — no Telegram, no formatting. |
| `src/messages.ts` | Modify | Add the `fixCheckin*` copy, the exported `HolderInfo` type, and two module-local helpers (`escapeHtml`, `holderLine`). All HTML composition lives here. |
| `src/bot.ts` | Modify | Add `resolveHolder`, `buildFixCheckinPicker`, `fixCheckinBlock`, the `/fixcheckin` command and three callback handlers, placed just after the `/delresp` block. |
| `CLAUDE.md` | Modify | Document the command under the role system and add a design note about holder identification. |

`src/commands.ts` is deliberately **not** touched — `/fixcheckin` takes an argument, and slash-menu
entries send with none (see the comment at `src/commands.ts:8`).

---

### Task 1: Mongo release primitive

**Files:**
- Modify: `src/visitor-store.ts` (append after `linkAndCheckInMongo`, which ends at line 156)

**Interfaces:**
- Consumes: `db`, `COLLECTIONS` (`src/mongo.ts`), `toVisitor` (module-local), `Visitor`
  (`src/checkin.ts`) — all already imported in this file.
- Produces:
  - `releaseCheckInMongo(rowIndex: number): Promise<Visitor | undefined>` — returns the visitor as it
    was **before** the release (so the caller has the old `telegramId`), or `undefined` when the row
    is missing or already free.
  - `findVisitorByRowMongo(rowIndex: number): Promise<Visitor | undefined>`

- [ ] **Step 1: Add both functions**

Append to `src/visitor-store.ts`:

```ts
/** Single-row read by sheet rowIndex — what the /fixcheckin confirm screen needs. Avoids
 *  pulling the whole mirror through getVisitorsMongo just to re-render one row. */
export async function findVisitorByRowMongo(rowIndex: number): Promise<Visitor | undefined> {
  const col = (await db()).collection(COLLECTIONS.visitors);
  const doc = await col.findOne({ _id: rowIndex as never });
  return doc ? toVisitor(doc as never) : undefined;
}

/**
 * Releases a wrongly-claimed row so the right person can check in — the exact inverse of
 * linkAndCheckInMongo. Mongo only: the sheet's Checked in / Telegram ID columns have not
 * been written since 2026-08-03 and stay untouched here too.
 *
 * doctorStatus is deliberately kept. The motivating case is a swap — two people who picked
 * each other's rows — where both really were examined by the doctor, so both rows carry a
 * mark a real exam produced. See docs/superpowers/specs/2026-08-04-fix-checkin-design.md.
 *
 * Returns the pre-release visitor, because the caller needs the old telegramId to notify
 * that account. The clear is a single guarded findOneAndUpdate rather than read-then-write,
 * so two admins racing on the same row produce exactly one release and one notification.
 */
export async function releaseCheckInMongo(rowIndex: number): Promise<Visitor | undefined> {
  const col = (await db()).collection(COLLECTIONS.visitors);
  const before = await col.findOneAndUpdate(
    { _id: rowIndex as never, telegramId: { $type: "string", $ne: "" } },
    { $set: { telegramId: "", checkedIn: "" } },
    { returnDocument: "before" },
  );
  return before ? toVisitor(before as never) : undefined;
}
```

Note for the implementer: the mongodb driver is v7 (`package.json`), where `findOneAndUpdate`
resolves to the document itself, **not** to a `{ value }` wrapper — that wrapper was removed in v6.
Do not add `.value`.

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no errors. (If TS complains about `returnDocument`, confirm the string literal is
`"before"`, not `"BEFORE"`.)

- [ ] **Step 3: Commit**

```bash
git add src/visitor-store.ts
git commit -m "feat(checkin): add releaseCheckInMongo and findVisitorByRowMongo"
```

---

### Task 2: Messages and HTML composition

**Files:**
- Modify: `src/messages.ts` (helpers near `pluralUk` at the top; message keys in the admin block,
  next to `delRespGone` at line 215)

**Interfaces:**
- Consumes: nothing. This file has no imports and must keep none.
- Produces:
  - `export interface HolderInfo { id: string; name: string; username?: string }`
  - `M.fixCheckinUsage`, `M.fixCheckinNotFound`, `M.fixCheckinFound(n)`,
    `M.fixCheckinRow(opts)`, `M.fixCheckinBtn(name)`, `M.fixCheckinConfirm(block)`,
    `M.fixCheckinAlreadyFree`, `M.fixCheckinDone(name, id, notified)`, `M.fixCheckinCancelled`,
    `M.fixCheckinReleasedDm`
  - `M.fixCheckinRow` signature, exactly:
    ```ts
    (o: {
      n?: number;            // omit on the confirm screen — no "1." prefix there
      name: string;
      team: string;
      room: string;
      checkedIn: string;
      doctorDone: boolean;
      holder: HolderInfo | null;   // null means the row is not claimed
    }) => string
    ```

The spec sketched this as `(n, v: Visitor, holder)`. It takes primitives instead so `messages.ts`
stays import-free, per the Global Constraints.

- [ ] **Step 1: Add the type and the two module-local helpers**

Insert above `export const M = {` in `src/messages.ts`:

```ts
/** Telegram identity of the account holding a visitor row, resolved at render time by
 *  the caller. `name` is empty when the lookup failed (deleted account, bot blocked) —
 *  the ID alone still renders, so the admin always has something to copy. */
export interface HolderInfo {
  id: string;
  name: string;
  username?: string;
}

/** Visitor names come from a Google Form and usernames from Telegram; both land inside
 *  parse_mode: "HTML" text, so anything that could open a tag has to be escaped. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The 👤 line: a tappable link to whoever claimed the row, plus the raw ID.
 *  https://t.me/<username> always opens the chat; tg://user?id= opens the profile only
 *  when that account's privacy settings allow it, and degrades to plain text when not.
 *  The <code> ID is always present so a failed link still leaves something copyable. */
function holderLine(h: HolderInfo): string {
  const id = `ID: <code>${h.id}</code>`;
  if (!h.name) return `   👤 ${id}`;
  const name = escapeHtml(h.name);
  const link = h.username
    ? `<a href="https://t.me/${encodeURIComponent(h.username)}">${name}</a> (@${escapeHtml(h.username)})`
    : `<a href="tg://user?id=${h.id}">${name}</a>`;
  return `   👤 ${link} · ${id}`;
}
```

- [ ] **Step 2: Add the message keys**

Insert into the `M` object immediately after `delRespGone` (line 215):

```ts
  fixCheckinUsage:
    "Використання: /fixcheckin <ПІБ або Telegram ID>\nНаприклад: /fixcheckin Петренко Іван",
  fixCheckinNotFound:
    "Нікого не знайдено. Спробуйте частину прізвища або Telegram ID людини.",
  fixCheckinFound: (n: number) => `📋 Знайдено ${n}:`,
  fixCheckinRow: (o: {
    n?: number;
    name: string;
    team: string;
    room: string;
    checkedIn: string;
    doctorDone: boolean;
    holder: HolderInfo | null;
  }): string => {
    const lines = [`${o.n ? `${o.n}. ` : ""}${escapeHtml(o.name)}`];
    const where = [o.team && `Команда ${o.team}`, o.room && `Кімната ${o.room}`]
      .filter(Boolean)
      .join(" · ");
    if (where) lines.push(`   ${escapeHtml(where)}`);
    if (o.holder) {
      lines.push(`   ✅ Відмічений ${escapeHtml(o.checkedIn)}`);
      lines.push(holderLine(o.holder));
    } else {
      lines.push("   ⬜ Не відмічений");
    }
    if (o.doctorDone) lines.push("   🩺 Медогляд пройдено");
    return lines.join("\n");
  },
  // Button labels ride in an inline keyboard, so long ПІБ values are truncated rather
  // than wrapped into an unreadable row.
  fixCheckinBtn: (name: string) =>
    `♻️ Скасувати чек-ін: ${name.length > 24 ? `${name.slice(0, 23)}…` : name}`,
  fixCheckinConfirm: (block: string) => `${block}\n\nСкасувати чек-ін цієї людини?`,
  fixCheckinAlreadyFree: "Цей рядок уже вільний — чек-ін скасовано раніше.",
  fixCheckinDone: (name: string, id: string, notified: boolean) =>
    `Чек-ін скасовано ✅\n${escapeHtml(name)} · ID: <code>${id}</code>\n` +
    (notified
      ? "Людину повідомлено — вона може відмітитись заново."
      : "⚠️ Не вдалося повідомити цю людину (можливо, заблокувала бота). Скажіть їй натиснути /start."),
  fixCheckinCancelled: "Дію скасовано.",
  fixCheckinReleasedDm:
    "Ваш чек-ін було скасовано адміністратором — схоже, було обрано чуже ім'я.\n\n" +
    "Натисніть /start і вкажіть своє прізвище та ім'я, щоб відмітитись заново.",
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/messages.ts
git commit -m "feat(checkin): add /fixcheckin messages and holder rendering"
```

---

### Task 3: Lookup and picker

**Files:**
- Modify: `src/bot.ts` (imports at the top; new code inserted after the `delrespcancel` handler, which
  ends at line 841, before `replyChunked`)

**Interfaces:**
- Consumes: `releaseCheckInMongo` is **not** used here (Task 4). Uses `findVisitorByTelegramIdMongo`,
  `getVisitorsMongo` (already imported), `searchByName` and `Visitor` (already imported),
  `loadAdmins`/`isAdmin` (already imported), `M`, `HolderInfo`, `safeAnswer`, `mongoGuarded`,
  `InlineKeyboard`.
- Produces:
  - `resolveHolder(telegramId: string): Promise<HolderInfo>` — always resolves; `name` is `""` on
    failure. (The spec wrote `HolderInfo | null`; returning a bare-ID `HolderInfo` instead means
    every caller renders the copyable ID with no null branch.)
  - `buildFixCheckinPicker(query: string): Promise<{ text: string; kb: InlineKeyboard } | null>`
  - `bot.command("fixcheckin", …)`

- [ ] **Step 1: Extend the imports**

In `src/bot.ts`, change the messages import (line 25) to:

```ts
import { M, roleCapabilitiesText, type HolderInfo } from "./messages";
```

and add `findVisitorByRowMongo` and `releaseCheckInMongo` to the `./visitor-store` import block
(lines 60–67), keeping it alphabetical:

```ts
import {
  findVisitorByRowMongo,
  findVisitorByTelegramIdMongo,
  getVisitorsMongo,
  linkAndCheckInMongo,
  markDoctorExamMongo,
  refreshPaymentStatusMongo,
  releaseCheckInMongo,
  syncVisitorsFromSheets,
} from "./visitor-store";
```

Both new imports are used in Task 4; adding them now keeps the import block edited once.
`npm run typecheck` does not flag unused imports in this project's config, but if the implementer's
editor does, ignore it until Task 4 lands.

- [ ] **Step 2: Add `resolveHolder`, the picker builder and the command**

Insert after the `delrespcancel` handler (line 841):

```ts
// --- /fixcheckin: release a wrongly-claimed check-in ---

/** A pure-digit argument is a Telegram ID, not a name — Ukrainian ПІБ never is. Five
 *  digits is below any real Telegram ID and safely above any team or room number. */
const FIXCHECKIN_ID_RE = /^\d{5,}$/;

/** Telegram identity of an account we only know by ID. The bot has, by definition, talked
 *  to every checked-in account, so getChat resolves name and @username for check-ins that
 *  are already in Mongo — nothing has to be captured at check-in time. A failure (deleted
 *  account, bot blocked) degrades to the bare ID; it must never break the picker, whose
 *  actual job is releasing the row. */
async function resolveHolder(telegramId: string): Promise<HolderInfo> {
  try {
    const chat = await bot.api.getChat(Number(telegramId));
    if (chat.type !== "private") return { id: telegramId, name: "" };
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
    return { id: telegramId, name, username: chat.username };
  } catch (err) {
    console.error("fixcheckin: getChat failed", telegramId, err);
    return { id: telegramId, name: "" };
  }
}

/** One rendered block for a row, with its holder resolved. Shared by the picker and the
 *  confirm screen so both always show the same detail. */
async function fixCheckinBlock(v: Visitor, n?: number): Promise<string> {
  return M.fixCheckinRow({
    n,
    name: v.name,
    team: v.team,
    room: v.room,
    checkedIn: v.checkedIn,
    doctorDone: Boolean(v.doctorStatus),
    holder: v.telegramId ? await resolveHolder(v.telegramId) : null,
  });
}

/** Rows matching the query, each with the Telegram identity of whoever claimed it.
 *  Lookups go through the Mongo mirror only — the Visitors tab shares the camp's 60
 *  reads/minute quota, and Mongo is authoritative for the link anyway. */
async function buildFixCheckinPicker(
  query: string,
): Promise<{ text: string; kb: InlineKeyboard } | null> {
  // By Telegram ID: the other end of a swap, when the admin has the person in front of
  // them but not the name they mistakenly claimed.
  const matches = FIXCHECKIN_ID_RE.test(query)
    ? [await findVisitorByTelegramIdMongo(Number(query))].filter((v): v is Visitor => !!v)
    : searchByName(await getVisitorsMongo(), query);
  if (matches.length === 0) return null;

  // searchByName caps at 5, so this is at most 5 concurrent getChat calls, each already
  // catch-guarded inside resolveHolder — one failed lookup degrades one line, never the
  // whole message.
  const blocks = await Promise.all(matches.map((v, i) => fixCheckinBlock(v, i + 1)));

  const kb = new InlineKeyboard();
  // Unclaimed rows are still listed — seeing that the ID is *not* there is half the
  // diagnosis — but only a claimed row has anything to release.
  for (const v of matches) {
    if (!v.telegramId) continue;
    kb.text(M.fixCheckinBtn(v.name), `fixci:${v.rowIndex}`).row();
  }

  return {
    text: `${M.fixCheckinFound(matches.length)}\n\n${blocks.join("\n\n")}`,
    kb,
  };
}

bot.command("fixcheckin", mongoGuarded(async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);

  const query = ctx.match.trim();
  if (!query) return ctx.reply(M.fixCheckinUsage);

  const picker = await buildFixCheckinPicker(query);
  if (!picker) return ctx.reply(M.fixCheckinNotFound);
  return ctx.reply(picker.text, { parse_mode: "HTML", reply_markup: picker.kb });
}));
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual check against the dev bot**

Requires `.env` pointed at a **test** bot token and a scratch spreadsheet, and the caller's Telegram
ID in `ADMIN_IDS`.

Run: `npm run dev`

In Telegram, against the dev bot:
1. Check in as yourself under some name, so one row is claimed.
2. Send `/fixcheckin <part of that name>`.
   Expected: a `📋 Знайдено N:` message; your row shows `✅ Відмічений <timestamp>`, a `👤` line with
   your Telegram name (tappable) and `ID: <your id>` in monospace, and a
   `♻️ Скасувати чек-ін: …` button. Tapping the name opens your own chat/profile.
3. Send `/fixcheckin <your Telegram ID>`.
   Expected: the same single row.
4. Send `/fixcheckin щосьнеіснуюче` → `fixCheckinNotFound`. Send bare `/fixcheckin` →
   `fixCheckinUsage`.
5. Send `/fixcheckin <name of a row nobody claimed>`.
   Expected: the row is listed with `⬜ Не відмічений` and **no** button.
6. Repeat step 2 with a second account that has **no** Telegram username set.
   Expected: the `👤` line still renders — name linked via `tg://user?id=`, or plain text if that
   account's privacy settings block it — and the `ID:` part is present either way. The message must
   not fail to send; a Telegram HTML parse error here would mean an unescaped name.

Do not tap the release button yet — the handler lands in Task 4 and an unhandled callback would
simply spin.

- [ ] **Step 5: Commit**

```bash
git add src/bot.ts
git commit -m "feat(checkin): add /fixcheckin lookup and picker"
```

---

### Task 4: Confirm, release and notify

**Files:**
- Modify: `src/bot.ts` (insert directly after the `/fixcheckin` command handler added in Task 3)

**Interfaces:**
- Consumes: `findVisitorByRowMongo`, `releaseCheckInMongo` (Task 1), `fixCheckinBlock` (Task 3),
  `M.fixCheckinConfirm` / `M.fixCheckinAlreadyFree` / `M.fixCheckinDone` / `M.fixCheckinCancelled` /
  `M.fixCheckinReleasedDm` (Task 2), `safeAnswer`, `mongoGuarded`, `InlineKeyboard`.
- Produces: three callback handlers — `fixci:<rowIndex>`, `fixciyes:<rowIndex>`, `fixcicancel`.

- [ ] **Step 1: Add the three handlers**

Insert after the `bot.command("fixcheckin", …)` block:

```ts
bot.callbackQuery(/^fixci:(\d+)$/, mongoGuarded(async (ctx) => {
  // Answer first: Telegram invalidates the query ~15s after the tap, and answering after
  // the reads below has already cost this bot a committed write with no reply.
  await safeAnswer(ctx);

  const rowIndex = Number(ctx.match[1]);
  const visitor = await findVisitorByRowMongo(rowIndex);
  if (!visitor || !visitor.telegramId) {
    return tryTelegram("editMessageText", () => ctx.editMessageText(M.fixCheckinAlreadyFree));
  }

  // Resolve the block before entering tryTelegram — its callback is a plain arrow, so an
  // await inside it would not compile.
  const block = await fixCheckinBlock(visitor);
  const kb = new InlineKeyboard()
    .text("✅ Так, скасувати", `fixciyes:${rowIndex}`)
    .text("↩️ Скасувати", "fixcicancel");
  return tryTelegram("editMessageText", () =>
    ctx.editMessageText(M.fixCheckinConfirm(block), {
      parse_mode: "HTML",
      reply_markup: kb,
    }),
  );
}));

bot.callbackQuery(/^fixciyes:(\d+)$/, mongoGuarded(async (ctx) => {
  await safeAnswer(ctx);

  const rowIndex = Number(ctx.match[1]);
  const released = await releaseCheckInMongo(rowIndex);
  // Guarded update, so this also covers a second admin (or a redelivered update) getting
  // here first — the row is released exactly once and notified exactly once.
  if (!released) {
    return tryTelegram("editMessageText", () => ctx.editMessageText(M.fixCheckinAlreadyFree));
  }

  // Best effort: the account may have blocked the bot, and a failed DM must not undo a
  // release that already committed. remove_keyboard drops the now-invalid visitor buttons
  // in one go rather than letting them fail one tap at a time — same reasoning as
  // replyRoleRevoked.
  let notified = true;
  try {
    await bot.api.sendMessage(Number(released.telegramId), M.fixCheckinReleasedDm, {
      reply_markup: { remove_keyboard: true },
    });
  } catch (err) {
    console.error("fixcheckin: notifying released account failed", released.telegramId, err);
    notified = false;
  }

  return tryTelegram("editMessageText", () =>
    ctx.editMessageText(M.fixCheckinDone(released.name, released.telegramId, notified), {
      parse_mode: "HTML",
    }),
  );
}));

bot.callbackQuery("fixcicancel", async (ctx) => {
  await safeAnswer(ctx);
  return tryTelegram("editMessageText", () => ctx.editMessageText(M.fixCheckinCancelled));
});
```

Note: `editMessageText` called without `reply_markup` removes the inline keyboard, so the confirm
buttons disappear once the release resolves. That is intended — a second tap on a stale keyboard is
what `fixCheckinAlreadyFree` exists for, but not offering the buttons is better than relying on it.

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual check of the release path**

Run: `npm run dev`, with two Telegram accounts (A = participant, B = admin) against the dev bot.

1. As **A**, check in under name X. Confirm A gets the normal check-in flow.
2. As **B**, `/fixcheckin X` → tap `♻️ Скасувати чек-ін: X`.
   Expected: the message becomes the confirm screen — same row detail, no `1.` number prefix, with
   `✅ Так, скасувати` / `↩️ Скасувати`.
3. Tap `↩️ Скасувати`. Expected: «Дію скасовано.», buttons gone.
4. `/fixcheckin X` again → tap the release button → tap `✅ Так, скасувати`.
   Expected: B sees «Чек-ін скасовано ✅» with A's name and copyable ID, and the "людину повідомлено"
   line. A receives the DM and A's reply keyboard disappears.
5. As **A**, send `/start`. Expected: the welcome + «Напишіть своє прізвище та ім'я» — not
   «Ви вже відмічені».
6. As **A**, check in under a different name Y. Expected: normal check-in.
7. As **B**, `/fixcheckin X` again. Expected: X now shows `⬜ Не відмічений` with no button, and
   `🩺 Медогляд пройдено` still present if it was there before the release — confirm this
   explicitly, it is the one behaviour most likely to regress.
8. Re-open the confirm screen for some row, release it from a second admin session, then tap
   `✅ Так, скасувати` on the first, stale screen. Expected: «Цей рядок уже вільний…», no second DM.

- [ ] **Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "feat(checkin): release a wrongly-claimed check-in via /fixcheckin"
```

---

### Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md` (the "Role system" section and the "Key design notes" list)

**Interfaces:**
- Consumes: the finished feature. Produces: nothing code-level.

- [ ] **Step 1: Document the command under the role system**

In `CLAUDE.md`, in the **Role system** section, append to the **Admin** bullet (tier 2) so it reads:

```markdown
2. **Admin** — rows in the `Admins` sheet. Can manage leaders, broadcast, and correct a
   wrongly-claimed check-in via `/fixcheckin` (typed-only, takes an argument, so no menu entry).
```

- [ ] **Step 2: Add the design note**

Append a bullet to **Key design notes**:

```markdown
- **A check-in link can be released, never transferred** — `/fixcheckin <ПІБ | Telegram ID>`
  (`src/bot.ts`) clears `telegramId`/`checkedIn` on one mirror row via `releaseCheckInMongo`
  (`src/visitor-store.ts`), after which both people simply check in again through the normal flow;
  there is no second check-in path to keep correct. `doctorStatus` is deliberately kept: the case
  this exists for is a *swap*, where both people really were examined. The account that claimed the
  row is identified at render time with `bot.api.getChat` — the bot has talked to every checked-in
  account by definition, so this works retroactively and stores nothing new. MC registrations are
  keyed by `telegramId` with names resolved at read time, so they follow the person and re-resolve
  once they check in correctly; nothing about them needs touching on release.
```

- [ ] **Step 3: Verify the docs match the code**

Run: `grep -n "fixcheckin" CLAUDE.md src/bot.ts`
Expected: the command name appears in both, spelled identically (`fixcheckin`, no underscore or dash).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document /fixcheckin in CLAUDE.md"
```

---

## Deployment

Not part of any task — the user deploys. For reference: `npx vercel --prod`, then
`npm run set-webhook`. No new environment variable, no Mongo index, and no `/sync*` run is required
by this feature.

**Standing hazard, unchanged by this work:** `/syncvisitors` re-inserts `telegramId`, `checkedIn` and
`doctorStatus` from the sheet, which nothing has written since 2026-08-03. Running it wipes check-ins
recorded since then and would equally reverse a `/fixcheckin` release. It is out of scope here (see
the spec) but should not be run casually while this feature is in use.
