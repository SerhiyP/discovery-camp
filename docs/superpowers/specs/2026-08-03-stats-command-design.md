# `/stats` admin command

Date: 2026-08-03

## Purpose

Admins have no single-glance view of camp turnout or masterclass engagement. `/stats`
reports two things in one message: how many visitors have checked in out of the total
roster, and how many active masterclass registrations exist, broken down by day and slot.

## Access

Admin-gated: superadmins (`ADMIN_IDS`) and `Admins` sheet rows, via the existing
`isAdmin(ctx.from?.id, admins)` check (`src/admins.ts`) — same gate as `/syncmc` and
`/syncvisitors` (`src/bot.ts`).

Typed command only (`/stats`). Not added to `ADMIN_COMMANDS` (`src/commands.ts`) — no
menu entry, consistent with other zero-friction admin tools the team runs ad hoc.

## Data sources

No new Mongo collections, fields, or sync logic. Both counts are pure aggregations over
data already synced by `/syncvisitors` and `/syncmc`:

- **Visitors**: `getVisitorsMongo()` (`src/visitor-store.ts`) → total count; checked-in
  count via `checkedIn !== ""` (the live Mongo write-through field set by
  `linkAndCheckInMongo`, authoritative per the 2026-08-03 check-in migration).
- **MC registrations**: `getRegistrations()` (`src/mc-store.ts`), filtered to
  `active: true`, grouped by `date` then `slot`. `mcSeats` (the atomic seat-counter
  collection) is not used for reporting — it's a per-(date,slot,mcId) counter, not
  aggregation-friendly for a day-level rollup; counting straight from `registrations`
  is simpler and just as accurate.

Fetched concurrently: `Promise.all([getVisitorsMongo(), getRegistrations()])`.

## Handler

New `bot.command("stats", ...)` in `src/bot.ts`, following the `/syncmc` shape:

```ts
bot.command("stats", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  try {
    const [visitors, regs] = await Promise.all([getVisitorsMongo(), getRegistrations()]);
    // aggregate, format, replyChunked
  } catch (err) {
    console.error("stats failed", err);
    return ctx.reply(M.statsFailed);
  }
});
```

Own try/catch, not `mongoGuarded` — matches the other admin sync/report commands, which
report failures via a dedicated message rather than the generic "try again in a minute"
used on user-facing Mongo reads.

Aggregation logic (visitor counts + group-by-date-then-slot over active registrations)
is a small pure function, colocated in `src/bot.ts` next to the handler — no existing
module is a natural home and it's not reused elsewhere, so no new exported helper.

## Output format

Ukrainian, via `replyChunked(ctx, lines, 3500)` (`src/bot.ts`) since the number of days
with scheduled masterclasses could push the message past Telegram's 4096-char limit as
the camp schedule grows.

```
📊 Статистика табору

Відвідувачів: 340
Заселено: 212 (62%)

Реєстрації на МК:
2026-08-03
  12:00-13:00: 45
  14:00-15:00: 38
2026-08-04
  12:00-13:00: 40
  14:00-15:00: 33

Всього реєстрацій: 156
```

- Percentage rounded to nearest integer; guard divide-by-zero (0 visitors → "0%").
- Days sorted ascending by date string (`YYYY-MM-DD` sorts lexically); slots within a
  day in the order they first appear in `registrations` (no existing canonical slot
  ordering to sort against — the schedule tab's row order isn't preserved in Mongo).
- Days/slots with zero active registrations are omitted (nothing to show).
- "Всього реєстрацій" is the sum of all active registrations shown above — a redundant
  total, kept because per-slot counts alone make the grand total tedious to eyeball.

## New message strings

Add to `M` (`src/messages.ts`): `statsFailed` (generic failure reply), and any static
labels needed for the format above (header, "Відвідувачів", "Заселено", "Реєстрації на
МК", "Всього реєстрацій") — following the existing convention of keeping all
user-facing strings in `messages.ts` rather than inline in the handler.

## Out of scope

- Per-masterclass-title breakdown (catalog join) — day/slot granularity only, per design
  discussion.
- Per-team breakdown.
- Historical/trend tracking (this is a live snapshot, not a stored metric).
- Command-menu entry.
