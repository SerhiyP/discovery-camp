# Keyboard UX & Leader Flow Improvements — Design Spec

**Date:** 2026-06-12

## Goal

Replace typed commands with a persistent bottom keyboard so visitors and leaders tap buttons instead of typing `/events`, `/schedule`, etc. Also fix several data-layer issues discovered during testing.

---

## 1. Persistent Reply Keyboard

### Roles and keyboards

| User state | Keyboard shown |
|---|---|
| Not yet linked (no check-in) | None — welcome text only, type name to check in |
| Visitor (checked in) | `📅 Події сьогодні` · `🗓 Розклад` / `📋 Мої реєстрації` |
| Leader (linked) | Visitor row + `📢 Сповістити команду` · `✏️ Перейменувати команду` |
| Admin / superadmin | No keyboard change — use commands |

A user who is both a visitor and a leader gets the leader keyboard.

### When the keyboard is set

- After visitor links (`link` callback) — check if also a leader and pick the right keyboard
- After leader links (`link_leader` callback) — always leader keyboard
- On `/start` when already linked — restore correct keyboard (re-check both roles)

### Button behaviour

| Button | Action |
|---|---|
| `📅 Події сьогодні` | Same as `/events` |
| `🗓 Розклад` | Same as `/schedule` |
| `📋 Мої реєстрації` | Same as `/myevents` |
| `📢 Сповістити команду` | Reply with usage hint: "Напишіть /notifyteam <текст>" |
| `✏️ Перейменувати команду` | Reply with usage hint: "Напишіть /renameteam <нова назва>" |

Button handlers registered via `bot.hears()` before `message:text` so they don't fall into the name-search path.

Command handlers (`/events` etc.) stay unchanged. Both command and hears paths call the same extracted logic function (no duplication).

---

## 2. Room Display After Check-in

The Form Responses tab now has a "Кімната" column. After a visitor links:

> Готово, Іван! Ви відмічені ✅  
> Ваша кімната: 204  
> Гарного табору! 🎉

If the column is missing or the cell is empty, the room line is silently omitted.

The video from the team leader is sent immediately after the text reply (already implemented).

**Config:** `ROOM_HEADER` env var, defaulting to `"Кімната"`.

---

## 3. Videos Tab — ID-Based Lookup

The Videos tab now has an ID column (same value as the visitor's "Команда" field). Lookup and update use exact ID match via `headerIndex` instead of the old normalised name comparison.

Schema: `ID | Team | File ID | Type`

`videoForTeam(teamId)` — find row where ID column === teamId (exact, trimmed).  
`updateTeamVideo(teamId, fileId, isVideoNote)` — find row by ID, update columns; append if not found.

---

## 4. Video Handler — Admin + Leader Combo

When a superadmin or admin who is also a leader sends a video:
1. Reply with `file_id` (admin path)
2. **Continue** to leader check — save to their team video and confirm "video updated"

Achieved by removing the early `return` after the admin reply and always falling through to the leader section.

---

## 5. Out of Scope

- Team assignment UI (visitor → team mapping remains manual in the spreadsheet)
- Session/conversation state for leader action buttons (notify/rename use text hints)
- Admin keyboard
