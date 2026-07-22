# Per-occurrence masterclass topics — design

**Date:** 2026-07-22
**Status:** Approved

## Problem

Some masterclasses run on multiple days with the *same* content, but a few run
the same MC slot with a *different topic* each day. Example: `Дівчащий простір`
(№4) runs every day of the camp, but the discussion topic changes daily
("Моє тіло — моє діло", "Що зі мною не так?", …). We want to surface today's
topic to visitors: in the `/mc` masterclass list and in the reminder-cron
broadcast.

A topic is optional and sparse — only some MCs, on some days, have one.

## Scope of a topic

A topic attaches to a `(date, MC ID)` pair. Each MC runs at most once per day,
so date + MC ID uniquely identifies an occurrence — `Slot` is not part of the
key.

## Storage

Topics live as a **third block inside the existing `MCSchedule` tab**, laid out
as a pivot matrix that a human can read and edit at a glance:

```
№ | Назва             | 2026-08-03          | 2026-08-04        | ...
1.| Татова майстерня  |                     |                   |
...
4.| Дівчащий простір  | Моє тіло — моє діло  | Що зі мною не так? | ...
...
```

- **Rows** are masterclasses (`№` + human-readable `Назва`).
- **Columns** past `Назва` are dates (`YYYY-MM-DD`).
- **Each cell** is the topic for that MC on that date; blank = no topic.

This block sits below the schedule block (cols A–C) and beside/below the
catalog block (cols E–H) already in `MCSchedule`. No new tab, and because `/mc`
and the cron already fetch the whole `MCSchedule` tab via `loadMCTabRows`,
reading topics costs **zero extra Sheets requests**.

### Header detection

The topics header row is detected by `col A === "№"` **and** `col B === "Назва"`.
This is distinct from the catalog header (whose `№` lives in col E) and from the
schedule header (`Date | Slot | MC IDs`).

The date columns are every header cell after `Назва` that matches
`^\d{4}-\d{2}-\d{2}$`.

### Row parsing

For each data row below the header:

- `№` is normalized like the catalog: `^(\d+)\.?$` → the numeric ID (`4.` → `4`).
  Rows without a numeric `№` are skipped.
- `Назва` is ignored by the parser (present only for human readability).
- For each date column, a non-empty (trimmed) cell sets
  `topics["${date}|${id}"] = topic`.

## Read layer — `src/masterclasses.ts`

```ts
/** Reads the topic-matrix block of the MCSchedule tab into a lookup keyed
 *  `${date}|${mcId}` -> topic. Reuses prefetched tab rows; no extra fetch. */
export async function loadMCTopics(prefetched?: string[][]): Promise<Map<string, string>>
```

- Detect the header via the rule above; if not found, return an empty map.
- Skip rows with non-numeric `№`; skip blank cells.

```ts
/** One `📌 <title>: <topic>` line per MC in `mcIds` that has a topic on `date`.
 *  MCs without a topic (or unknown IDs) produce no line. */
export function topicLines(
  mcIds: string[],
  mcs: Masterclass[],
  topics: Map<string, string>,
  date: string,
): string[]
```

The topic references the MC **by title** because it renders in message text,
while the MC titles the user taps live on the inline-keyboard buttons.

## Harden `loadMCSchedule`

Today `loadMCSchedule` iterates every row and would also read the new topics
block as schedule rows; those bogus entries are currently harmless only because
`todaySlots` filters by ISO date. Tighten the loader to accept a row **only when
its `Date` cell matches `^\d{4}-\d{2}-\d{2}$`**, so the topics block (and any
future extra block) can never leak into the schedule regardless of date
filtering.

## Display integration

Topics render in **message text, never in button labels** (labels are already
tight against Telegram's 64-byte callback limit and the capacity suffix).

### `/mc` — `handleMasterclasses` (`src/bot.ts`)

- Load topics from the already-fetched `tabRows` (`loadMCTopics(tabRows)`).
- For each of today's slots, collect `topicLines(s.mcIds, mcs, topics, s.date)`.
- Compose the message body as `M.mcDayTitle` followed by the collected topic
  lines (a blank line between title and topics when any exist). Keyboard
  unchanged.

### Reminder cron — `api/cron/mc-reminder.ts`

- Add `loadMCTopics(tabRows)` to the post-early-exit `Promise.all` (so it only
  runs when there's a matching slot today).
- For each slot, append `topicLines(s.mcIds, mcs, topics, s.date)` to the
  `M.mcReminder(s.slot)` text used in the broadcast.

## Messages — `src/messages.ts`

Add the Ukrainian formatting string:

```ts
mcTopicLine: (title: string, topic: string) => `📌 ${title}: ${topic}`,
```

`topicLines` uses this so all user-facing text stays in `messages.ts`.

## Non-goals

- No admin command to edit topics — they are hand-edited in the sheet like the
  schedule and catalog.
- No per-slot topics (one slot per MC per day is assumed).
- No change to registration, capacity, or `buildSlotButtons`.

## Testing

There are no automated tests in this repo; verify via `npm run typecheck` and a
manual check against the live sheet:

- `/mc` on a day where №4 has a topic shows the `📌` line; days/MCs without a
  topic show none.
- The reminder cron body includes the topic line for the reminded slot's MCs
  that have one.
- The schedule grid and `/mc` buttons are unaffected by the new block.
