# Role Capabilities Info — Design

**Date:** 2026-07-04
**Status:** Approved for planning

## Goal

New users don't know what the bot can do. Give them a short blurb of the bot's general
capabilities before they register, and a short role-specific "here's what you can do"
message right after they register (visitor / leader / responsible — a person can hold
more than one). Also add `/help` so anyone can recall this later.

## Behavior

### 1. Pre-registration blurb

`M.welcome` (shown on `/start` when the caller isn't linked to anything yet) gains a
short "what this bot does" blurb before the existing check-in instruction:

```
Вітаємо в Discovery Camp! 🏕

Тут можна:
🎨 реєструватись на майстер-класи
🗓 дивитись розклад табору
📋 бачити свої реєстрації

Щоб почати, відмітьтесь на реєстрації — напишіть своє прізвище та ім'я, так, як ви
вказували їх у формі реєстрації.
```

### 2. Post-registration capability message

After each of the three check-in confirmations — visitor (`link:`), leader
(`link_leader:`), responsible (`link_resp:`) in `src/bot.ts` — send one extra short
follow-up message built from the person's **full current role set**, not just the role
they just linked (a leader who later also links as responsible should see
leader+responsible capabilities in that second message, not responsible-only). This
mirrors how `roleKeyboard()` already composes the reply keyboard from the full role set.

Extract the role-lookup that's currently inlined in `keyboardForUser()` into a shared
helper:

```ts
async function getUserRoles(telegramId: number): Promise<{
  isVisitor: boolean;
  isLeader: boolean;
  isResponsible: boolean;
}> {
  const [{ leaders }, { responsible }, { visitors }] = await Promise.all([
    loadLeaders(),
    loadResponsible(),
    loadVisitors(),
  ]);
  return {
    isVisitor: !!findByTelegramId(visitors, telegramId),
    isLeader: findLeadersByTelegramId(leaders, telegramId).length > 0,
    isResponsible: findResponsibleByTelegramId(responsible, telegramId).length > 0,
  };
}
```

`keyboardForUser()` becomes a thin wrapper: call `getUserRoles`, return
`roleKeyboard({...})` if any role is set, else `undefined`.

After each link handler's confirmation reply, call `getUserRoles` again (roles may have
changed by the write that just happened) and reply with `roleCapabilitiesText(roles)`.

### 3. `roleCapabilitiesText` in `src/messages.ts`

Bullet blocks mirror the actual reply-keyboard buttons so the text never drifts from
what's really tappable:

```ts
export function roleCapabilitiesText(opts: { leader?: boolean; responsible?: boolean }): string {
  const parts = [M.capabilitiesBase];
  if (opts.leader) parts.push(M.capabilitiesLeader);
  if (opts.responsible) parts.push(M.capabilitiesResponsible);
  return parts.join("\n\n");
}
```

New `M` entries:

```ts
capabilitiesBase:
  "Ось що вам доступно:\n" +
  "🎨 Майстер-класи — реєстрація на майстер-класи\n" +
  "🗓 Розклад — розклад табору на сьогодні\n" +
  "📋 Мої реєстрації — ваші записи на майстер-класи",
capabilitiesLeader:
  "👑 Як лідер команди:\n" +
  "📢 Сповістити команду — надіслати повідомлення своїй команді\n" +
  "✏️ Перейменувати команду — змінити назву команди",
capabilitiesResponsible:
  "🎨 Як відповідальний за майстер-клас:\n" +
  "👥 Учасники МК — список учасників вашого майстер-класу\n" +
  "📣 Сповістити учасників МК — надіслати їм повідомлення",
```

### 4. `/help` command

```ts
bot.command("help", async (ctx) => {
  const roles = await getUserRoles(ctx.from!.id);
  if (!roles.isVisitor && !roles.isLeader && !roles.isResponsible) {
    return ctx.reply(`${M.generalInfo}\n\n${M.mustCheckInFirst}`);
  }
  return ctx.reply(roleCapabilitiesText(roles));
});
```

The "Тут можна: ..." text is factored out to a module-level `const` above `export const
M = {...}` so both `M.generalInfo` (for `/help`) and `M.welcome` can use it without
duplicating the string:

```ts
const GENERAL_INFO =
  "Тут можна:\n" +
  "🎨 реєструватись на майстер-класи\n" +
  "🗓 дивитись розклад табору\n" +
  "📋 бачити свої реєстрації";

export const M = {
  generalInfo: GENERAL_INFO,
  welcome:
    "Вітаємо в Discovery Camp! 🏕\n\n" +
    `${GENERAL_INFO}\n\n` +
    "Щоб почати, відмітьтесь на реєстрації — напишіть своє прізвище та ім'я, так, як ви " +
    "вказували їх у формі реєстрації.",
  ...
```

### 5. `/help` in the command menu

Zero-arg, available to everyone → added to `USER_COMMANDS` in `src/commands.ts` (all
higher tiers already spread `...USER_COMMANDS`):

```ts
const USER_COMMANDS = [
  { command: "help", description: "Що вміє бот" },
  { command: "mc", description: "Майстер-класи сьогодні" },
  { command: "schedule", description: "Розклад" },
  { command: "myevents", description: "Мої реєстрації" },
];
```

## Out of scope

- Admin/superadmin-specific capabilities in `/help` — those commands are already
  discoverable via their own scoped Telegram command menus (`commands.ts`), which is
  the existing convention for admin-tier discoverability.
- Changing the video-greeting step in the visitor link handler — the new capabilities
  message is sent right after `M.checkedIn`, before the team video (if any), so the
  video remains the last thing in that sequence.
- Re-sending capabilities on every `/start` for already-linked users — that's what
  `/help` is for; `/start` keeps its current `M.alreadyLinked` behavior.

## Edge cases

- A person linking a second/third role (e.g. visitor who later becomes responsible)
  sees the full up-to-date capability set in the message sent after that second link,
  not just the newly-added role's block — because `getUserRoles` is re-queried fresh
  after each link rather than reusing state from the request that triggered it.
- Someone with no role at all running `/help` gets the same general blurb + check-in
  nudge as an unlinked `/start`, reusing `M.mustCheckInFirst` (already used elsewhere
  for the same "you're not linked yet" case).

## Verification

`npm run typecheck` must pass. Behavior confirmed after `npx vercel --prod` (no tests,
no local dev server in this repo): check in as a plain visitor and confirm the
capabilities follow-up appears with only the base block; check in as a leader and
confirm the leader block is added; run `/help` both before and after linking.
