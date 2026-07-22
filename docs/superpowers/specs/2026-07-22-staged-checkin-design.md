# Staged check-in: doctor QR → Аня → final message

**Date:** 2026-07-22
**Status:** approved

## Goal

Turn the current one-shot check-in into the multi-stage registration described in the camp
concept. After a participant confirms their name, they must pass a medical exam (doctor) and a
payment check (financist, Аня) before the bot sends the final confirmation. The final message
gains the participant's **leader (наставник) names** alongside team and room, and the team video
moves to that final message.

Flow per the concept:

1. Participant scans poster QR → writes name → confirms → **checked in**.
2. Bot shows a personal QR; doctor scans it → medical exam marked.
3. Bot tells participant to go to Аня; Аня marks payment in the sheet; participant taps a
   refresh button.
4. When both marks are present → final message (team, leaders, room) + team video.
5. Participant walks to their leader.

## Non-goals

- No doctor/financist roles in the bot. Any **admin/superadmin** can mark the medical exam
  (by scanning). Аня marks payment **directly in the Google Sheet**, not through the bot.
- No cron polling. Progression is event-driven (QR scan, button tap).
- No sheet schema changes — all needed columns already exist.

## Sheet columns (existing, already loaded)

From `config.ts` / `checkin.ts` `Visitor`:

- `Лікар` → `visitor.doctorStatus` (`doctorStatusHeader`)
- `Статус оплати` → `visitor.paymentStatus` (`paymentStatusHeader`)
- `Номер команди` → `visitor.team`
- `Кімната поселення` → `visitor.room`
- `Checked in` → `visitor.checkedIn`

**"Done" definitions:**

- Medical exam done ⇔ `Лікар` non-empty. The bot writes `nowStamp()` into it on scan.
- Payment done ⇔ `Статус оплати` non-empty. Аня fills any value in the sheet.

Both are checked with a simple `.trim() !== ""` test.

## Flow detail

### Stage 1 — name confirm (`link:` callback, modified)

`src/bot.ts` `bot.callbackQuery(/^link:(\d+)$/, …)`:

- Keep: link account, mark `Checked in` (via `linkAndCheckIn`), the "row taken"/"already
  linked" guards.
- **Remove** from this handler: the reply keyboard, `roleCapabilitiesText`, and the team video
  send. These move to the final message.
- After linking, re-read the visitor and branch:
  - If `doctorStatus` **and** `paymentStatus` are both already non-empty (re-link of a fully
    processed participant) → call `sendFinalMessage(ctx, visitor)`.
  - Otherwise → send the medical-exam prompt **with a personal QR photo** (see below).

### Personal QR

- Deep link: `https://t.me/<BOT_USERNAME>?start=med_<participantTelegramId>`.
  Keyed by **Telegram ID** (stable; participant is already linked), not row index.
- Generated at runtime: `QRCode.toBuffer(url, { width: 512, margin: 2 })` →
  `ctx.replyWithPhoto(new InputFile(buffer, "med-qr.png"), { caption: M.medQrCaption })`.
- `BOT_USERNAME` becomes **required** for this path. `config.botUsername` is currently optional
  (`?? ""`). Add a guard: if empty when building the QR, log and fall back to a text instruction
  (no crash), but the intent is that `BOT_USERNAME` is set in Vercel. (Import `InputFile` from
  `grammy`; add `import QRCode from "qrcode"`.)

### Stage 2 — doctor scan (`/start med_<id>`)

Modify `bot.command("start", …)` to parse the payload (`ctx.match`):

- Payload `med_<digits>`:
  - Verify the scanner is admin/superadmin (`isSuperAdmin(ctx.from.id)` or
    `isAdmin(ctx.from.id, admins)`). If not → reply `M.medNotAdmin` and stop.
  - Load visitors, find the target by Telegram ID (`findByTelegramId(visitors, targetId)`).
    Not found → `M.medVisitorNotFound`.
  - If `doctorStatus` already non-empty → tell the admin `M.medAlreadyDone(name)` and stop
    (idempotent; no second push to participant).
  - Else write `nowStamp()` into the `Лікар` column
    (`updateCell(config.responsesTab, rowIndex, cols.doctorStatus, nowStamp())`).
  - Reply to the **admin**: `M.medMarked(name)`.
  - Push to the **participant** via `bot.api.sendMessage(targetId, M.medPassed, { reply_markup: <button> })`
    where the button is an inline `🔄 Я пройшов(ла) Аню` → callback `checkanya`.
    Wrap the push in try/catch (participant may have blocked the bot); on failure the admin still
    gets their confirmation.
- Payload empty or `checkin` (poster QR) or anything else → existing `/start` behaviour
  (already-linked check + welcome).

### Stage 3 — Аня refresh (`checkanya` callback, new)

`bot.callbackQuery("checkanya", …)`:

- Load visitors, find self by Telegram ID. Not found → `answerCallbackQuery(M.mustCheckInFirst)`.
- If `paymentStatus` still empty → `answerCallbackQuery(M.anyaNotYet)` (toast, message stays so
  they can retry).
- If `paymentStatus` non-empty (and `doctorStatus` non-empty as a safety check) →
  `answerCallbackQuery()`, `deleteMessage()`, then `sendFinalMessage(ctx, visitor)`.
- If somehow payment is set but doctor is not → `answerCallbackQuery(M.anyaNotYet)` (shouldn't
  happen; button only appears post-doctor).

### Stage 4 — final message (`sendFinalMessage`, new helper)

`async function sendFinalMessage(ctx, visitor)` in `src/bot.ts`. Both call sites (the `link:`
re-link branch and the `checkanya` callback) run in the participant's own context, so the helper
takes `ctx`.

Steps:

1. Look up leaders: `loadLeaders()` → `leaders.filter(l => l.team === visitor.team)` (the
   `Leaders.team` column stores the numeric team ID, matching `visitor.team`). Collect their
   `name`s.
2. Build final text `M.registrationComplete({ team, leaders, room })`:
   - «Реєстрацію завершено 🎉»
   - team number (if present)
   - leader names (join `, `; omit the line if none found)
   - room (if present)
3. Reply with that text + the role-composed reply keyboard (`keyboardFromRoles(roles)`), where
   `roles = await getUserRoles(ctx.from.id)`.
4. Reply `roleCapabilitiesText(roles)`.
5. Send the team video (moved here): `videoForTeam(visitor.team)` → `replyWithVideoNote` /
   `replyWithVideo` exactly as the old `link:` handler did.

## New / changed strings (`src/messages.ts`)

- `medQrCaption` — "Ви відмічені ✅ Тепер пройдіть медогляд — покажіть цей QR-код лікарю 👨‍⚕️"
- `medPassed` — "Медогляд пройдено ✅ Тепер підійдіть до Ані (фінансист). Коли Аня відмітить оплату — натисніть кнопку нижче."
- `medNotAdmin` — "Цей QR-код призначений для медичного персоналу."
- `medVisitorNotFound` — "Не знайшли учасника 😔"
- `medAlreadyDone(name)` — "У {name} медогляд уже відмічено ✅"
- `medMarked(name)` — "✅ {name} — медогляд відмічено"
- `anyaNotYet` — "Аня ще не відмітила оплату 🙂 Зачекайте і спробуйте ще раз."
- `registrationComplete({ team, leaders, room })` — the final multi-line message.
- Button label `btnCheckAnya` — "🔄 Я пройшов(ла) Аню"

`M.checkedIn` and `M.videoCaption` stay (videoCaption still used by the final video).

## Edge cases

| Case | Handling |
|---|---|
| Non-admin scans the personal QR | `M.medNotAdmin`, no write |
| Doctor scans twice | Second scan: `M.medAlreadyDone`, no second participant push |
| Participant blocked the bot | `bot.api.sendMessage` push wrapped in try/catch; admin still confirmed |
| Participant taps refresh before Аня | `M.anyaNotYet` toast; button/message persists |
| Re-link of fully processed participant | Straight to `sendFinalMessage` |
| No leaders assigned to the team | Leader line omitted; rest of final message still sent |
| `BOT_USERNAME` unset | Guard falls back to text instruction instead of crashing |

## Files touched

- `src/bot.ts` — `link:` handler (trim), `start` payload parsing, `checkanya` callback,
  `sendFinalMessage` helper, `QRCode`/`InputFile` imports.
- `src/messages.ts` — new strings above.
- No changes to `config.ts` schema, `checkin.ts`, `leaders.ts`, or the sheet.

## Testing

No automated tests exist in this repo (per CLAUDE.md). Verify via `npm run typecheck` and a
manual walk-through on the deployed bot:

1. Scan poster QR → confirm name → receive personal QR.
2. Scan personal QR from an admin account → admin sees "медогляд відмічено", participant gets
   "підійдіть до Ані" + button.
3. Tap button before payment set → "Аня ще не відмітила".
4. Set `Статус оплати` in the sheet → tap button → final message with leader names, room,
   keyboard, and team video.
