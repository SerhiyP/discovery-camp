# Two-Way Communication (Help Desk + Team Chat Hint) — Design Spec

**Date:** 2026-08-08
**Status:** Approved design.

## Problem

All bot communication points downward: admins `/broadcast` to everyone, leaders notify
their team, responsible people notify MC attendees. A visitor has no path upward — any
text they type falls through to name search. The two concrete pains:

1. Team communication only works when a leader creates their own Telegram group and gets
   every kid into it; a kid outside the group (or in a team with no group) is cut off.
2. There is no way for a visitor to reach the doctor or the organizers at all.

## Key decisions (made 2026-08-08)

| Decision | Choice |
|---|---|
| Scope | General help desk: one entry point, routed by category (leader / doctor / admins) |
| Team groups | Stay leader-created, real Telegram groups. The bot does **not** join them — it only hints leaders to create one and distribute the invite link via the existing «📢 Сповістити команду». The `/teamchat` bind-the-bot machinery is explicitly deferred (v2 if the gap hurts) |
| Reply path | Depends on role: leaders answer kids by normal Telegram DM (forward carries a `tg://` link); doctor and admins reply **through the bot**, keeping their accounts private |
| Doctor identity | New `DOCTOR_IDS` env var (mirrors `ADMIN_IDS`). First feature to hang off it; others (e.g. med-exam scan gating) may follow later |
| Tracking | Every request is a Mongo doc with an open/closed flag and a «✅ Опрацьовано» button; `/stats` shows open counts. No full ticket lifecycle |
| Hosting / state | Stays on Vercel serverless. Pending conversation state lives in Mongo (not memory), so the same code runs unchanged if the bot ever moves to a long-polling server — the hosting decision stays reversible |

## Design

### Entry: «🙋 Допомога»

New button on **every** role's reply keyboard. Tapping it shows an inline picker:
«🙋 Лідеру» / «🩺 Лікарю» / «📋 Організаторам». Picking a category stores a pending-action
doc and replies «напиши своє питання одним повідомленням». The visitor's next text
message becomes the request.

### Pending state — one mechanism, two directions

Collection `pendingActions`, keyed by Telegram ID (one doc per person, last tap wins):

```
{ _id: <telegramId>, kind: "help" | "reply",
  category?: "leader"|"doctor"|"admin",   // kind: "help"
  requestId?: <ObjectId>,                 // kind: "reply"
  createdAt }
```

One check at the top of the `message:text` handler, **after** keyboard-button/command
matching but **before** name-search fallthrough: if the sender has a pending doc younger
than 10 minutes, this message is the payload for that action — consume (delete) the doc
and execute. Older docs are ignored and overwritten by the next tap; there is no cleanup
job. This is the only conversation-state primitive; both the kid's question capture and
the staff reply capture are `kind` values interpreted by the same check.

Crash-safety follows the check-in flow's philosophy: the doc survives a dead lambda; if
the lambda dies after consuming but before sending, the person taps the button and sends
again. Every step is re-entrant.

### Routing

- **Лідеру** — forwarded to the visitor's team leaders (join: `Leaders.Team` vs the
  visitor's team ID, as in the roster views) with name, age, room and a
  `tg://user?id=` profile link. Leaders answer by normal DM — no reply machinery. A team
  with no linked leader falls back to admins, so no request lands nowhere.
- **Лікарю** — sent to everyone in `DOCTOR_IDS`.
- **Організаторам** — sent to all admins (`ADMIN_IDS` + `Admins` sheet).

Doctor/admin copies carry two inline buttons:

- «✉️ Відповісти» — writes `{_id: staffId, kind: "reply", requestId}`; the staff
  member's next message is relayed to the kid as «🩺 Відповідь лікаря: …» /
  «📋 Відповідь організаторів: …». One reply per tap — the pending doc is consumed, so
  unrelated staff typing never lands in a kid's chat; to answer again, tap again.
- «✅ Опрацьовано» — closes the request. A second closer gets a toast naming who already
  handled it (no error, no double-close).

### Request log

Collection `helpRequests`:

```
{ _id: ObjectId, telegramId, category, text, createdAt,
  status: "open"|"closed", closedBy?, closedAt? }
```

Names/team resolved at read time from the visitors mirror (same principle as MC
registrations). `/stats` gains a line: open requests per category. Callback data carries
the ObjectId hex (24 chars — fits the 64-byte limit).

### Team chat hint (the whole of "Part A")

- Leader capability text and `/help` gain a line: «створіть групу команди і розішліть
  запрошення через 📢 Сповістити команду».
- Known gap: a kid who checks in after the leader sent the invite misses the link.
  Mitigation: the leader re-sends the notify (new check-ins are visible in
  «👥 Моя команда»). If this hurts in practice, v2 is the deferred `/teamchat` binding
  (bot joins the group, auto-DMs the invite link at check-in).

### Cross-cutting

- All existing handlers get gated to private chats (`bot.chatType("private")`) — pure
  hygiene now that groups are near the bot's orbit; the bot itself never joins one.
- House rules apply: `safeAnswer` on every callback, `mongoGuarded` on every handler,
  role re-checks inside callbacks (callback data is client-forgeable), recipient lists
  loaded in one batched Sheets read, `replyChunked` where output can grow.
- Doctor gets a `capabilitiesDoctor` block in `roleCapabilitiesText()` and a scoped
  command menu entry if any argument-less commands appear.

## Error handling

- Mongo outage: every handler is `mongoGuarded` — «спробуйте за хвилину», never a 500
  Telegram would redeliver.
- Pending doc missing/expired when the message arrives: the message falls through to the
  normal text path (name search / ignored) — never a crash, never a mis-routed request.
- «✉️ Відповісти» on an already-closed request still works (a late answer is better than
  a swallowed one); the staff member sees the closed status in the confirmation.
- A `DOCTOR_IDS` recipient who has never opened the bot can't be messaged
  (`sendMessage` 403) — send errors per recipient are caught and skipped, same as
  `/broadcast`.

## Testing

Manual script on the dev bot (test token + scratch Mongo, per `scripts/dev.ts`):

1. Check in a test kid; verify «🙋 Допомога» appears on the keyboard.
2. One request per category; verify routing, the leader-forward's `tg://` link, and the
   no-leader → admins fallback.
3. Doctor reply relay end-to-end, including a second «✉️ Відповісти» tap.
4. «✅ Опрацьовано» twice from two accounts — second gets the who-closed-it toast.
5. Abandoned tap: pick a category, wait >10 min, send text — must fall through to the
   normal path, not become a request.
6. `/stats` shows the open-request counts.

## Out of scope

- `/teamchat` group binding and invite-link automation (v2, only if the hint proves
  insufficient).
- A «virtual group» relay (bot re-broadcasting kids' messages to teammates).
- Moving off Vercel — an ops change; this design deliberately keeps state in Mongo so it
  requires no code change.