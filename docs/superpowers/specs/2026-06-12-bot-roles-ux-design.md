# Discovery Camp Bot — Enhanced Roles & UX

**Date:** 2026-06-12  
**Status:** Approved

## Overview

Extend the grammY Telegram bot with a three-tier role system (superadmin / admin / leader), scoped command menus per role, team leader self-check-in, team management commands, and a small name-search UX fix.

---

## 1. Data Model

### New sheet tabs

**`Admins`** tab — bot-managed list of admins (superadmin adds via command):

| Column | Value |
|---|---|
| Telegram ID | Telegram user ID (string) |
| Name | Display name |
| Added at | Timestamp (Kyiv time) |

**`Leaders`** tab — bot-managed list of team leaders (admin adds via command):

| Column | Value |
|---|---|
| Team | Team name (canonical) |
| Name | Leader's full name |
| Telegram ID | Filled in when leader completes check-in |
| Added at | Timestamp (Kyiv time) |

Up to 3 rows per team are allowed (3 leaders per team). Multiple rows share the same `Team` value.

### Role checks (in-process, checked per request)

- `isSuperAdmin(id)` — checks `ADMIN_IDS` env var (existing)
- `isAdmin(id)` — checks Admins tab OR `isSuperAdmin(id)`
- `getLeaderTeams(id)` — returns array of team names from Leaders tab where Telegram ID matches; empty array if not a leader

---

## 2. New Modules

| Module | Responsibility |
|---|---|
| `src/admins.ts` | `loadAdmins`, `addAdmin`, `removeAdmin`, `findAdminByTelegramId` |
| `src/leaders.ts` | `loadLeaders`, `addLeader`, `removeLeader`, `findLeaderByTelegramId`, `searchLeaderByName`, `setLeaderTelegramId`, `renameTeam` |
| `src/commands.ts` | `setCommandsForUser(bot, userId, role)` — sets per-chat scoped command menu |

`renameTeam(oldName, newName)` updates:
1. All rows in the `Leaders` tab where `Team === oldName`
2. All rows in the responses sheet where the team cell equals `oldName`

---

## 3. Command Reference

### Available to everyone
| Command | Description |
|---|---|
| `/start` | Welcome / already-linked status |
| `/myid` | Replies with the user's Telegram ID (for sharing with superadmin) |
| `/leader` | Explains the leader check-in flow and prompts name entry |

### User commands
| Command | Description |
|---|---|
| `/events` | Today's events with register/unregister buttons |
| `/schedule` | Full upcoming schedule |
| `/myevents` | User's registrations |

### Leader commands (in addition to user commands)
| Command | Description |
|---|---|
| `/notifyteam <text>` | Sends `text` to all team members who have a Telegram ID in the responses sheet |
| `/renameteam <newname>` | Renames leader's team in Leaders tab + all member rows in responses sheet |
| *(send a video)* | Bot updates the Videos tab for the leader's team with the new `file_id` |

If a leader leads multiple teams, `/notifyteam` and `/renameteam` ask them to choose which team first (inline keyboard).

### Admin commands (in addition to leader commands)
| Command | Description |
|---|---|
| `/addleader <Team> <Name>` | Adds a row to Leaders tab (no Telegram ID yet). `Team` = first word; `Name` = everything after first word. Team names must be single words (e.g. `Alpha`, `Команда1`). |
| `/removeleader <Team> <Name>` | Removes matching row. Same parsing: first word = team, rest = name. |
| `/listleaders` | Lists all leaders with team, name, and check-in status |
| `/broadcast <text>` | Sends `text` to all checked-in visitors (existing) |

### Superadmin commands (in addition to admin commands)
| Command | Description |
|---|---|
| `/addadmin <TelegramID> <Name>` | Adds row to Admins tab; sets scoped command menu for that user |
| `/removeadmin <TelegramID>` | Removes row from Admins tab |
| `/listadmins` | Lists all admins with name and Telegram ID |

---

## 4. Leader Check-in Flow (stateless)

1. Leader runs `/leader` — bot replies with an explanation and prompt to type their name.
2. Leader types their name (any text message).
3. The existing `message:text` handler is extended: after searching visitors, it also searches the `Leaders` tab via `searchLeaderByName`. If unlinked matches are found, it shows `link_leader:<rowIndex>` buttons alongside any visitor results.
4. Leader taps their name button → `link_leader` callback links their Telegram ID in the Leaders tab and calls `setCommandsForUser` to activate the leader command menu.
5. Bot confirms: "Готово! Ви підключені як лідер команди «TeamName» ✅"

No session state is required — the name search checks both sheets on every text message until the user is linked.

---

## 5. Command Menu (scoped per user)

Uses `bot.api.setMyCommands()` with `BotCommandScopeChat` (private chat scope per user ID).

**When menus are set:**
- Bot startup: sets default user menu + per-chat menus for all superadmins (from env) and any already-linked admins (from Admins tab)
- `/addadmin` executed: sets admin menu for the new admin's chat
- `/removeadmin` executed: re-checks if that user is still a leader; if yes, sets leader menu; otherwise resets to user menu
- `link_leader` callback completes: sets leader menu for that chat

**Menu contents per role** (each role inherits the previous tier):

- **User:** `/events`, `/schedule`, `/myevents`
- **Leader:** above + `/notifyteam`, `/renameteam`
- **Admin:** above + `/addleader`, `/removeleader`, `/listleaders`, `/broadcast`
- **Superadmin:** above + `/addadmin`, `/removeadmin`, `/listadmins`

`/start`, `/myid`, and `/leader` are universal and not shown in the menu (they work without being listed).

---

## 6. Name Search UX Fix

Two message strings in `messages.ts` are updated:

- `chooseYourself`: `"Знайшли кілька збігів. Натисніть на своє ім'я 👇"`
- `confirmOne`: `"Це ви? Натисніть, щоб підтвердитись 👇"`

---

## 7. Error Handling

- `/notifyteam` with no team members who have a Telegram ID → reply "У вашій команді ще ніхто не підключився до бота."
- `/renameteam` to a name that already exists in Leaders tab → reply with a warning and ask to confirm.
- `/addleader` for a team already at 3 leaders → bot refuses and shows current leaders for that team.
- Admin commands used by non-admin → silently ignored (existing pattern).
- Leader video upload when leader leads multiple teams → bot asks which team to update.

---

## 8. Files Changed / Created

| File | Change |
|---|---|
| `src/admins.ts` | New |
| `src/leaders.ts` | New |
| `src/commands.ts` | New |
| `src/bot.ts` | Add all new command handlers; extend text + video handlers |
| `src/messages.ts` | Add new strings; update `chooseYourself`, `confirmOne` |
| `src/config.ts` | Add tab name constants: `adminsTab`, `leadersTab` |
| `src/sheets.ts` | No changes expected |
| `src/checkin.ts` | Add `updateTeamVideo(team, fileId)` — writes new file_id to Videos tab for a given team |
