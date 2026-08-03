# Masterclass Registration on MongoDB — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the masterclass path and the camp schedule to zero Google Sheets read requests, and make registration capacity race-free, before the next `mc-reminder` cron firing (13:00 Kyiv daily until 2026-08-07).

**Architecture:** MongoDB becomes the store for the masterclass catalog, schedule, topics, registrations, a scoped visitors mirror, and a cached copy of the badge-grid camp schedule. Sheets stays the source of truth for the catalog, the grid and the Visitors tab, imported by admin commands (`/syncmc`, `/syncvisitors`, `/syncschedule`). Registrations live only in Mongo, where a unique partial index makes "one active registration per slot" a database guarantee rather than a read-count-append race. The `EventRegs` tab is retired — **including its readers**: `👥 Учасники МК`, `📣`/`/notifymc`, `🎨 МК команди` and `/caught` all switch to Mongo, with attendee names resolved from the visitors mirror.

**Tech Stack:** TypeScript, grammY, `mongodb` Node driver (new dependency), Vercel serverless.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-03-mongo-operational-store-design.md`. This plan implements rollout steps 1–2, the camp schedule, and a **scoped slice of step 3**: a visitors mirror used only for `telegramId` lookups (check-in gate, attendee names, reminder recipients). Check-in name search, role tabs, videos and team rename stay on Sheets — out of scope.
- **No tests.** Verification is `npm run typecheck` plus the manual production checklist in Task 7. Do not create a `tests/` directory or add a test script.
- **Payment and doctor status are never mirrored to Mongo** (spec: "never cached — read live"). The visitor docs deliberately omit them; «Я пройшов(ла) Аню» keeps reading Sheets live.
- `api/bot.ts` has `maxDuration: 10` (`vercel.json`). Mongo connect and query timeouts must stay well inside that budget.
- Vercel spawns many concurrent lambdas. The Mongo client MUST be created once at module scope and reused; never per request.
- **No expensive work at module scope** (CLAUDE.md). Creating the client object is lazy and cheap; do not `await connect()` at import time.
- **A Mongo failure must never become an uncaught handler error.** There is no global `bot.catch` (deliberate, per CLAUDE.md), so an uncaught error → HTTP 500 → Telegram redelivers the same update — the amplification loop that turned the quota problem into an outage. Every Mongo-backed handler goes through the `mongoGuarded` wrapper (Task 5).
- All user-facing strings go in `src/messages.ts` in the `M` object. Ukrainian only.
- Admin commands are gated with `isAdmin(ctx.from?.id, admins)` and reply `M.notAdmin` otherwise.
- Never leave a raw NUL byte or other control character in source. `npm run typecheck` will not catch it; `git diff --stat` reporting a `.ts` file as `Bin` is the signal.

---

### Task 1: Mongo connection module

A single shared client, safe for serverless.

**Files:**
- Create: `src/mongo.ts`
- Modify: `src/config.ts:20` (add `mongoUri`, `mongoDb`)
- Modify: `package.json` (add `mongodb` dependency)

**Interfaces:**
- Consumes: `config` from `src/config.ts`.
- Produces:
  - `db(): Promise<Db>` — the shared database handle, connecting on first use.
  - `mongoEnabled(): boolean` — whether `MONGO_URI` is configured.
  - `COLLECTIONS` — `{ masterclasses, mcSchedule, mcTopics, registrations, visitors, mcSeats, campSchedule }`.

- [ ] **Step 1: Install the driver**

```bash
npm install mongodb
```

- [ ] **Step 2: Add config entries**

In `src/config.ts`, after the `gridSheetId` line (currently line 20), add:

```typescript
  // MongoDB — operational store for masterclasses, registrations and the camp schedule.
  // Optional: when unset the bot keeps using Sheets for everything.
  mongoUri: process.env.MONGO_URI ?? "",
  mongoDb: process.env.MONGO_DB ?? "discovery_camp",
```

- [ ] **Step 3: Write the connection module**

Create `src/mongo.ts`:

```typescript
import { Db, MongoClient } from "mongodb";
import { config } from "./config";

export const COLLECTIONS = {
  masterclasses: "masterclasses",
  mcSchedule: "mcSchedule",
  mcTopics: "mcTopics",
  registrations: "registrations",
  visitors: "visitors",
  mcSeats: "mcSeats",
  campSchedule: "campSchedule",
} as const;

export function mongoEnabled(): boolean {
  return !!config.mongoUri;
}

// One client per serverless instance, reused across invocations. Vercel spawns many
// lambdas under load, so a per-request client would exhaust the Atlas connection limit.
// The object is created lazily and connect() is never awaited at module scope —
// api/bot.ts has maxDuration 10, and import-time work is paid by every cold start.
let client: MongoClient | null = null;
let connecting: Promise<Db> | null = null;

export async function db(): Promise<Db> {
  if (!config.mongoUri) throw new Error("MONGO_URI is not configured");
  if (connecting) return connecting;
  connecting = (async () => {
    client = new MongoClient(config.mongoUri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await client.connect();
    return client.db(config.mongoDb);
  })();
  try {
    return await connecting;
  } catch (err) {
    // Let the next request retry instead of caching a failed connection forever.
    connecting = null;
    client = null;
    throw err;
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add src/mongo.ts src/config.ts package.json package-lock.json
git commit -m "feat(mongo): add a serverless-safe shared client

One client per lambda instance, created lazily and reused. Vercel spawns
many concurrent instances, so a per-request client would exhaust the Atlas
connection limit; connect() is not awaited at module scope because every
cold start would pay for it inside a 10s budget."
```

---

### Task 2: Mongo-backed masterclass catalog and `/syncmc`

Import the `MCSchedule` tab into Mongo and read the catalog from there.

**Files:**
- Create: `src/mc-store.ts`
- Modify: `src/messages.ts` (add sync messages)
- Modify: `src/bot.ts` (add `/syncmc`)

**Interfaces:**
- Consumes: `db()`, `COLLECTIONS` from `src/mongo.ts`; `Masterclass`, `SlotSchedule`, `loadMCTabRows`, `loadMasterclasses`, `loadMCSchedule`, `loadMCTopics` from `src/masterclasses.ts`.
- Produces:
  - `syncMCFromSheets(): Promise<{ masterclasses: number; slots: number; topics: number }>`
  - `getMasterclasses(): Promise<Masterclass[]>`
  - `getMCSchedule(): Promise<SlotSchedule[]>`
  - `getMCTopics(): Promise<Map<string, string>>` — keyed `"<date>|<mcId>"`, matching the existing sheet-backed shape.

- [ ] **Step 1: Write the store**

Create `src/mc-store.ts`:

```typescript
import { Masterclass, SlotSchedule, loadMCTabRows, loadMasterclasses, loadMCSchedule, loadMCTopics } from "./masterclasses";
import { COLLECTIONS, db } from "./mongo";

/** Re-imports the MCSchedule tab into Mongo. Replaces rather than upserts, so a row
 *  deleted from the sheet disappears here too. Sheets stays the source of truth for
 *  the catalog; Mongo is the copy every request reads. The delete-then-insert window
 *  is accepted: /syncmc runs rarely, by an admin, and a failed insert is fixed by
 *  re-running the command. */
export async function syncMCFromSheets(): Promise<{
  masterclasses: number;
  slots: number;
  topics: number;
}> {
  const rows = await loadMCTabRows();
  const [mcs, schedule, topics] = await Promise.all([
    loadMasterclasses(rows),
    loadMCSchedule(rows),
    loadMCTopics(rows),
  ]);
  const database = await db();

  const mcDocs = mcs.map((m) => ({ _id: m.id, ...m }));
  const slotDocs = schedule.map((s) => ({ _id: `${s.date}|${s.slot}`, ...s }));
  const topicDocs = [...topics.entries()].map(([key, topic]) => ({ _id: key, topic }));

  await database.collection(COLLECTIONS.masterclasses).deleteMany({});
  if (mcDocs.length) await database.collection(COLLECTIONS.masterclasses).insertMany(mcDocs as never);
  await database.collection(COLLECTIONS.mcSchedule).deleteMany({});
  if (slotDocs.length) await database.collection(COLLECTIONS.mcSchedule).insertMany(slotDocs as never);
  await database.collection(COLLECTIONS.mcTopics).deleteMany({});
  if (topicDocs.length) await database.collection(COLLECTIONS.mcTopics).insertMany(topicDocs as never);

  return { masterclasses: mcDocs.length, slots: slotDocs.length, topics: topicDocs.length };
}

export async function getMasterclasses(): Promise<Masterclass[]> {
  const docs = await (await db()).collection(COLLECTIONS.masterclasses).find({}).toArray();
  return docs.map((d) => ({
    id: String(d.id ?? d._id),
    title: String(d.title ?? ""),
    responsible: String(d.responsible ?? ""),
    place: String(d.place ?? ""),
    capacity: Number(d.capacity ?? 0),
  }));
}

export async function getMCSchedule(): Promise<SlotSchedule[]> {
  const docs = await (await db()).collection(COLLECTIONS.mcSchedule).find({}).toArray();
  return docs.map((d) => ({
    date: String(d.date ?? ""),
    slot: String(d.slot ?? ""),
    mcIds: (d.mcIds as string[]) ?? [],
  }));
}

export async function getMCTopics(): Promise<Map<string, string>> {
  const docs = await (await db()).collection(COLLECTIONS.mcTopics).find({}).toArray();
  return new Map(docs.map((d) => [String(d._id), String(d.topic ?? "")]));
}
```

- [ ] **Step 2: Add the messages**

In `src/messages.ts`, after the `menusSynced` entry, add:

```typescript
  mcSynced: (mcs: number, slots: number, topics: number) =>
    `Каталог МК оновлено ✅\nМайстер-класів: ${mcs}, слотів: ${slots}, тем: ${topics}.`,
  syncFailed: "Не вдалося синхронізувати. Спробуйте ще раз за хвилину.",
```

- [ ] **Step 3: Add the `/syncmc` command**

In `src/bot.ts`, add next to the other admin sync commands (near `/syncresp`):

```typescript
bot.command("syncmc", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  try {
    const counts = await syncMCFromSheets();
    return ctx.reply(M.mcSynced(counts.masterclasses, counts.slots, counts.topics));
  } catch (err) {
    console.error("syncmc failed", err);
    return ctx.reply(M.syncFailed);
  }
});
```

Add to the imports at the top of `src/bot.ts`:

```typescript
import { syncMCFromSheets } from "./mc-store";
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/mc-store.ts src/messages.ts src/bot.ts
git commit -m "feat(mc): import the masterclass catalog into Mongo via /syncmc

Sheets stays the source of truth for the catalog; Mongo is the copy every
request reads. Sync replaces rather than upserts so a row deleted from the
sheet disappears here too."
```

---

### Task 3: Visitors mirror and `/syncvisitors`

A scoped mirror of the Visitors tab, used only for `telegramId` lookups: the mcreg check-in gate, attendee-name resolution, and reminder recipients. Payment and doctor status are deliberately excluded (spec: never cached). Check-in name search stays on Sheets.

**Files:**
- Create: `src/visitor-store.ts`
- Modify: `src/mongo.ts` — nothing (collection name added in Task 1)
- Modify: `src/messages.ts` (add sync message)
- Modify: `src/bot.ts` (add `/syncvisitors`; write-through after `linkAndCheckIn`)

**Interfaces:**
- Consumes: `Visitor`, `loadVisitors` from `src/checkin.ts`; `db()`, `COLLECTIONS` from `src/mongo.ts`.
- Produces:
  - `syncVisitorsFromSheets(): Promise<number>`
  - `getVisitorsMongo(): Promise<Visitor[]>` — adapter to the existing `Visitor` shape, `paymentStatus`/`doctorStatus` always `""`.
  - `findVisitorByTelegramIdMongo(telegramId: number): Promise<Visitor | undefined>` — Mongo lookup with a Sheets fallback on miss.
  - `upsertVisitorMongo(v: Visitor): Promise<void>` — write-through used at check-in.

Import direction is one-way (`visitor-store` → `checkin`); the write-through call lives in `src/bot.ts`, **not** inside `linkAndCheckIn`, to avoid a circular import.

- [ ] **Step 1: Write the store**

Create `src/visitor-store.ts`:

```typescript
import { Visitor, loadVisitors } from "./checkin";
import { COLLECTIONS, db } from "./mongo";

// Mirror of the Visitors tab for telegramId lookups only. Payment and doctor status
// are deliberately NOT mirrored — the doctor gate must always read Sheets live.
interface VisitorDoc {
  _id: number; // sheet rowIndex, 0-based incl. header — what updateCell addresses
  name: string;
  age: string;
  team: string;
  room: string;
  specialNeeds: string;
  telegramId: string;
  checkedIn: string;
}

function toVisitor(d: Partial<VisitorDoc>): Visitor {
  return {
    rowIndex: Number(d._id ?? -1),
    name: String(d.name ?? ""),
    age: String(d.age ?? ""),
    paymentStatus: "",
    doctorStatus: "",
    team: String(d.team ?? ""),
    room: String(d.room ?? ""),
    specialNeeds: String(d.specialNeeds ?? ""),
    telegramId: String(d.telegramId ?? ""),
    checkedIn: String(d.checkedIn ?? ""),
  };
}

/** Replaces the mirror from the Visitors tab. Replace, not upsert: row indices shift
 *  when staff delete a sheet row, and a replace self-corrects that on the next sync. */
export async function syncVisitorsFromSheets(): Promise<number> {
  const { visitors } = await loadVisitors();
  const docs: VisitorDoc[] = visitors.map((v) => ({
    _id: v.rowIndex,
    name: v.name,
    age: v.age,
    team: v.team,
    room: v.room,
    specialNeeds: v.specialNeeds,
    telegramId: v.telegramId,
    checkedIn: v.checkedIn,
  }));
  const col = (await db()).collection(COLLECTIONS.visitors);
  await col.deleteMany({});
  if (docs.length) await col.insertMany(docs as never);
  return docs.length;
}

export async function getVisitorsMongo(): Promise<Visitor[]> {
  const docs = await (await db()).collection(COLLECTIONS.visitors).find({}).toArray();
  return docs.map((d) => toVisitor(d as never));
}

/** Mongo lookup by Telegram ID. On a miss, falls back to one Sheets read and
 *  back-fills the mirror — covers a check-in that happened after the last sync
 *  when the write-through also failed. */
export async function findVisitorByTelegramIdMongo(
  telegramId: number,
): Promise<Visitor | undefined> {
  const col = (await db()).collection(COLLECTIONS.visitors);
  const doc = await col.findOne({ telegramId: String(telegramId) });
  if (doc) return toVisitor(doc as never);
  const { visitors } = await loadVisitors();
  const v = visitors.find((x) => x.telegramId === String(telegramId));
  if (v) await upsertVisitorMongo(v).catch(() => {});
  return v;
}

/** Write-through from check-in, so the next MC tap sees the link without a re-sync. */
export async function upsertVisitorMongo(v: Visitor): Promise<void> {
  const col = (await db()).collection(COLLECTIONS.visitors);
  await col.updateOne(
    { _id: v.rowIndex as never },
    {
      $set: {
        name: v.name,
        age: v.age,
        team: v.team,
        room: v.room,
        specialNeeds: v.specialNeeds,
        telegramId: v.telegramId,
        checkedIn: v.checkedIn,
      },
    },
    { upsert: true },
  );
}
```

- [ ] **Step 2: Add the message and command**

In `src/messages.ts`, after `mcSynced`:

```typescript
  visitorsSynced: (count: number) => `Учасників синхронізовано ✅\nЗаписів: ${count}.`,
```

In `src/bot.ts`, next to `/syncmc`:

```typescript
bot.command("syncvisitors", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  try {
    return ctx.reply(M.visitorsSynced(await syncVisitorsFromSheets()));
  } catch (err) {
    console.error("syncvisitors failed", err);
    return ctx.reply(M.syncFailed);
  }
});
```

- [ ] **Step 3: Write-through at check-in**

In `src/bot.ts`, find the call site of `linkAndCheckIn` (the check-in confirmation callback). Immediately after a successful link (`ok === true`), add:

```typescript
  if (mongoEnabled()) {
    // Best-effort: check-in is Sheets-owned and must not break on a Mongo outage.
    upsertVisitorMongo({
      ...visitor,
      telegramId: String(ctx.from.id),
      checkedIn: visitor.checkedIn || nowStamp(),
    }).catch((err) => console.error("visitor write-through failed", err));
  }
```

(Adjust variable names to the surrounding code; `visitor` is the row `linkAndCheckIn` returned.) Import `mongoEnabled` from `./mongo` and `upsertVisitorMongo`, `syncVisitorsFromSheets` from `./visitor-store`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/visitor-store.ts src/messages.ts src/bot.ts
git commit -m "feat(visitors): scoped Mongo mirror for telegramId lookups

Used by the MC check-in gate, attendee-name resolution and the reminder
cron. Payment and doctor status are deliberately not mirrored — the doctor
gate always reads Sheets live. Check-in write-through is best-effort so a
Mongo outage cannot break check-in itself."
```

---

### Task 4: Registrations in Mongo with atomic capacity

The core of the change. Registration becomes a Mongo insert guarded by a unique index.

**Files:**
- Modify: `src/mc-store.ts` (add registration functions)

**Interfaces:**
- Consumes: `db()`, `COLLECTIONS`.
- Produces, mirroring the existing sheet-backed signatures in `src/masterclasses.ts` so call sites change as little as possible:
  - `ensureIndexes(): Promise<void>`
  - `MongoRegistration` — `{ date: string; slot: string; mcId: string; telegramId: string; active: boolean }`
  - `getRegistrations(): Promise<MongoRegistration[]>`
  - `registerMongo(date, slot, mcId, capacity, telegramId): Promise<RegisterResult>` — `RegisterResult` is the existing `"ok" | "full" | "already" | "slot_taken"` from `src/masterclasses.ts`. Capacity is enforced by an atomic per-(date, slot, mcId) counter in the `mcSeats` collection (`takeSeat`/`returnSeat`, module-private), not by count-then-insert.
  - `unregisterMongo(date, slot, mcId, telegramId): Promise<boolean>` — gives the seat back on success.
  - `rebuildSeatCounters(): Promise<void>` — recomputes `mcSeats` from active registrations; called at the end of `syncMCFromSheets` so every `/syncmc` heals counter drift.
  - `asMCRegistrations(regs: MongoRegistration[]): MCRegistration[]` — adapter for the pure helpers.

- [ ] **Step 1: Implement the registration functions**

Append to `src/mc-store.ts` (merge the imports into the existing import statements):

```typescript
import { MCRegistration, RegisterResult } from "./masterclasses";
import { nowStamp } from "./config";

export interface MongoRegistration {
  date: string;
  slot: string;
  mcId: string;
  telegramId: string;
  active: boolean;
}

/** Creates the unique partial index that makes "one active registration per slot" a
 *  database guarantee. `active` is an explicit boolean rather than a `cancelledAt: null`
 *  predicate, because a filter on null also matches documents where the field is absent. */
export async function ensureIndexes(): Promise<void> {
  const database = await db();
  const regs = database.collection(COLLECTIONS.registrations);
  await regs.createIndex(
    { date: 1, slot: 1, telegramId: 1 },
    { unique: true, partialFilterExpression: { active: true } },
  );
  await regs.createIndex({ date: 1, slot: 1, mcId: 1 });
  await database.collection(COLLECTIONS.visitors).createIndex({ telegramId: 1 });
}

export async function getRegistrations(): Promise<MongoRegistration[]> {
  const docs = await (await db()).collection(COLLECTIONS.registrations).find({}).toArray();
  return docs.map((d) => ({
    date: String(d.date ?? ""),
    slot: String(d.slot ?? ""),
    mcId: String(d.mcId ?? ""),
    telegramId: String(d.telegramId ?? ""),
    active: d.active === true,
  }));
}

/** Adapts Mongo documents to the shape the pure helpers in masterclasses.ts expect
 *  (buildSlotButtons, activeRegs, hasActiveRegistrationForSlot). Those functions are
 *  array-only and stay unchanged; rowIndex is unused by them, and name is resolved
 *  from the visitors mirror where a view needs it. */
export function asMCRegistrations(regs: MongoRegistration[]): MCRegistration[] {
  return regs.map((r) => ({
    rowIndex: -1,
    date: r.date,
    slot: r.slot,
    mcId: r.mcId,
    telegramId: r.telegramId,
    name: "",
    cancelled: !r.active,
  }));
}

// ── Seat counters ────────────────────────────────────────────────────────────
// Capacity is enforced by a per-(date, slot, mcId) counter document in `mcSeats`:
// `findOneAndUpdate` with `taken: { $lt: capacity }` and `$inc` is atomic on a
// single document, so overselling is impossible by construction — no post-insert
// re-check, no rollback, no ordering assumptions. (An earlier design compensated
// after insert with an _id-sorted rollback; ObjectIds from different lambdas in
// the same second sort by random bytes, so racers could disagree about who
// overflowed and both keep their seats. Reviewed and replaced 2026-08-03.)
// Drift (a crash between a seat-take and its registration insert leaks a seat)
// only ever undersells and is healed by /syncmc, which rebuilds the counters
// from active registrations.

/** Atomically takes one seat. Returns false when the MC is full. */
async function takeSeat(
  date: string,
  slot: string,
  mcId: string,
  capacity: number,
): Promise<boolean> {
  const col = (await db()).collection(COLLECTIONS.mcSeats);
  const key = `${date}|${slot}|${mcId}`;
  const inc = () =>
    col.findOneAndUpdate(
      { _id: key as never, taken: { $lt: capacity } },
      { $inc: { taken: 1 } },
    );
  if (await inc()) return true;
  // No matching doc: the MC is full, or the counter doesn't exist yet.
  try {
    const created = await col.updateOne(
      { _id: key as never },
      { $setOnInsert: { taken: 1 } },
      { upsert: true },
    );
    if (created.upsertedCount === 1) return true;
  } catch (err) {
    // Lost the create race to another lambda — fall through and increment theirs.
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  return (await inc()) !== null;
}

/** Gives a seat back. Floored at zero: counters rebuilt by /syncmc may already
 *  account for this cancellation. */
async function returnSeat(date: string, slot: string, mcId: string): Promise<void> {
  const col = (await db()).collection(COLLECTIONS.mcSeats);
  await col.updateOne(
    { _id: `${date}|${slot}|${mcId}` as never, taken: { $gt: 0 } },
    { $inc: { taken: -1 } },
  );
}

/** Rebuilds seat counters from active registrations. Heals any drift left by a
 *  crash between a seat-take and its registration insert. Called by /syncmc. */
export async function rebuildSeatCounters(): Promise<void> {
  const database = await db();
  const counts = await database
    .collection(COLLECTIONS.registrations)
    .aggregate([
      { $match: { active: true } },
      { $group: { _id: { $concat: ["$date", "|", "$slot", "|", "$mcId"] }, taken: { $sum: 1 } } },
    ])
    .toArray();
  const seats = database.collection(COLLECTIONS.mcSeats);
  await seats.deleteMany({});
  if (counts.length) await seats.insertMany(counts as never);
}

export async function registerMongo(
  date: string,
  slot: string,
  mcId: string,
  capacity: number,
  telegramId: number,
): Promise<RegisterResult> {
  const col = (await db()).collection(COLLECTIONS.registrations);
  const id = String(telegramId);

  const existing = await col.findOne({ date, slot, telegramId: id, active: true });
  if (existing) return String(existing.mcId) === mcId ? "already" : "slot_taken";

  const seated = capacity > 0 ? await takeSeat(date, slot, mcId, capacity) : true;
  if (!seated) return "full";

  try {
    await col.insertOne({
      date, slot, mcId, telegramId: id, active: true,
      registeredAt: nowStamp(), cancelledAt: "",
    } as never);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      // The unique index rejected a concurrent insert for the same person and
      // slot — give our seat back and report what the winner holds.
      if (capacity > 0) await returnSeat(date, slot, mcId).catch(() => {});
      const now = await col.findOne({ date, slot, telegramId: id, active: true });
      if (!now) return "full";
      return String(now.mcId) === mcId ? "already" : "slot_taken";
    }
    // Any other insert failure: return the seat, then rethrow — mongoGuarded
    // turns it into a "спробуйте за хвилину" reply.
    if (capacity > 0) await returnSeat(date, slot, mcId).catch(() => {});
    throw err;
  }

  return "ok";
}

export async function unregisterMongo(
  date: string,
  slot: string,
  mcId: string,
  telegramId: number,
): Promise<boolean> {
  const col = (await db()).collection(COLLECTIONS.registrations);
  const res = await col.updateOne(
    { date, slot, mcId, telegramId: String(telegramId), active: true },
    { $set: { active: false, cancelledAt: nowStamp() } },
  );
  if (res.modifiedCount === 0) return false;
  // Guarded at zero inside returnSeat; a decrement for an unlimited MC (no
  // counter doc) matches nothing and is a no-op.
  await returnSeat(date, slot, mcId).catch(() => {});
  return true;
}
```

- [ ] **Step 2: Wire counter healing into the catalog sync**

At the end of `syncMCFromSheets` (before its `return`), add:

```typescript
  await rebuildSeatCounters();
```

Also add `mcSeats: "mcSeats"` to `COLLECTIONS` in `src/mongo.ts` (after `visitors`).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/mc-store.ts src/mongo.ts
git commit -m "feat(mc): registrations in Mongo with atomic capacity

A unique partial index on (date, slot, telegramId) over active documents
makes one-registration-per-slot a database guarantee. Capacity is a
per-(date,slot,mcId) seat counter taken with a guarded atomic \$inc, so a
burst cannot oversell a slot; cancel returns the seat and /syncmc rebuilds
counters from active registrations to heal any crash-window drift."
```

---

### Task 5: Point every registration reader and writer at Mongo

Swap **all** the call sites. This is the task that actually removes the reads. There are seven registration readers, not four — `👥 Учасники МК`, `📣`/`/notifymc`, `🎨 МК команди` and `/caught` read `EventRegs` too, and would silently show "nobody registered" if left behind.

Every Mongo-backed handler is wrapped in `mongoGuarded` so a Mongo outage replies «спробуйте за хвилину» instead of becoming an HTTP 500 that Telegram redelivers.

**Files:**
- Modify: `src/bot.ts` — `handleMasterclasses`, `handleMyRegs`, the `mcreg:` and `mcunreg:` callbacks, `handleTeamMc`, `myOccurrencesToday`, `handleMcAttendees`, `notifyOccurrence`, `renderCaught`, plus the `mongoGuarded` wrapper
- Modify: `api/cron/mc-reminder.ts`
- Modify: `src/messages.ts` (add `tryAgainLater`, `mcAttendeeUnknown`)

**Interfaces:**
- Consumes: `getMasterclasses`, `getMCSchedule`, `getMCTopics`, `getRegistrations`, `registerMongo`, `unregisterMongo`, `asMCRegistrations` from `src/mc-store.ts`; `getVisitorsMongo`, `findVisitorByTelegramIdMongo` from `src/visitor-store.ts`.
- Note: `buildSlotButtons`, `activeRegs`, `hasActiveRegistrationForSlot` and `topicLines` in `src/masterclasses.ts` are **pure functions over arrays** and stay unchanged; feed them through `asMCRegistrations`.

- [ ] **Step 1: Add the messages**

In `src/messages.ts`:

```typescript
  tryAgainLater: "Тимчасова помилка. Спробуйте ще раз за хвилину.",
  mcAttendeeUnknown: (id: string) => `невідомий учасник (ID ${id})`,
```

- [ ] **Step 2: Add the `mongoGuarded` wrapper**

In `src/bot.ts`, near `safeAnswer`:

```typescript
/** Wraps a Mongo-backed handler. On failure it logs and answers with M.tryAgainLater
 *  instead of throwing — there is no global bot.catch, so an uncaught error becomes
 *  HTTP 500 and Telegram redelivers the same update in a loop. */
function mongoGuarded<C extends Context>(
  handler: (ctx: C) => Promise<unknown>,
): (ctx: C) => Promise<void> {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (err) {
      console.error("mongo-backed handler failed", err);
      if (ctx.callbackQuery) await safeAnswer(ctx as never, M.tryAgainLater);
      await ctx.reply(M.tryAgainLater).catch(() => {});
    }
  };
}
```

- [ ] **Step 3: Rewrite `handleMasterclasses`**

Replace the body with:

```typescript
async function handleMasterclasses(ctx: Context) {
  const [mcs, schedule, topics, regsRaw] = await Promise.all([
    getMasterclasses(),
    getMCSchedule(),
    getMCTopics(),
    getRegistrations(),
  ]);
  const regs = asMCRegistrations(regsRaw);
  const slots = todaySlots(schedule);
  const kb = new InlineKeyboard();
  const topicsLines: string[] = [];
  let anyListed = false;
  for (const s of slots) {
    const buttons = buildSlotButtons(s, mcs, regs, String(ctx.from!.id));
    if (buttons.length === 0) continue;
    kb.text(`— ${s.slot} —`, "mcnoop").row();
    for (const b of buttons) kb.text(b.label, b.cbData).row();
    topicsLines.push(...topicLines(s.mcIds, mcs, topics, s.date));
    anyListed = true;
  }
  if (!anyListed) return ctx.reply(M.noMasterclassesToday);
  const body = topicsLines.length ? [M.mcDayTitle, "", ...topicsLines].join("\n") : M.mcDayTitle;
  return ctx.reply(body, { reply_markup: kb });
}
```

- [ ] **Step 4: Rewrite `handleMyRegs`**

```typescript
async function handleMyRegs(ctx: Context) {
  const [mcs, topics, regs] = await Promise.all([
    getMasterclasses(),
    getMCTopics(),
    getRegistrations(),
  ]);
  const today = todayISO();
  const mine = regs.filter(
    (r) => r.telegramId === String(ctx.from!.id) && r.active && r.date >= today,
  );
  if (mine.length === 0) return ctx.reply(M.myRegsEmpty);
  const lines = [M.myRegsTitle, ""];
  for (const r of mine) {
    const mc = mcs.find((m) => m.id === r.mcId);
    if (mc) {
      const topic = topics.get(`${r.date}|${r.mcId}`);
      lines.push(`• ${r.date}, ${r.slot} — ${M.mcTitleWithTopic(mc.title, topic)} (${mc.place})`);
    }
  }
  return ctx.reply(lines.join("\n"));
}
```

- [ ] **Step 5: Rewrite the `mcreg:` callback**

The check-in gate **stays**, but checks the Mongo mirror instead of a Sheets read (with the store's built-in Sheets fallback on a miss — rare, since almost everyone is checked in):

```typescript
bot.callbackQuery(/^mcreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, mongoGuarded(async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  if (date !== todayISO()) return safeAnswer(ctx, M.noMasterclassesToday);
  const [mcs, topics, me] = await Promise.all([
    getMasterclasses(),
    getMCTopics(),
    findVisitorByTelegramIdMongo(ctx.from.id),
  ]);
  const mc = mcs.find((m) => m.id === mcId);
  if (!mc) return safeAnswer(ctx);
  if (!me) {
    await safeAnswer(ctx);
    return ctx.reply(M.mustCheckInFirst);
  }
  const result = await registerMongo(date, slot, mcId, mc.capacity, ctx.from.id);
  await safeAnswer(
    ctx,
    result === "ok"
      ? M.mcRegistered(mc.title, slot, mc.place)
      : result === "full"
        ? M.mcFull
        : result === "already"
          ? M.mcAlready
          : M.mcSlotTaken,
  );
  if (result === "ok") {
    const topic = topics.get(`${date}|${mcId}`);
    await ctx.reply(M.mcRegistered(mc.title, slot, mc.place, topic));
  }
  if (result === "slot_taken") await ctx.reply(M.mcSlotTaken);
}));
```

- [ ] **Step 6: Rewrite the `mcunreg:` callback**

```typescript
bot.callbackQuery(/^mcunreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, mongoGuarded(async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  if (date !== todayISO()) return safeAnswer(ctx, M.noMasterclassesToday);
  const mcs = await getMasterclasses();
  const mc = mcs.find((m) => m.id === mcId);
  const ok = await unregisterMongo(date, slot, mcId, ctx.from.id);
  await safeAnswer(ctx);
  if (ok && mc) await ctx.reply(M.mcUnregistered(mc.title, slot));
}));
```

- [ ] **Step 7: Rewrite `handleTeamMc` and `handleTeamRoster`** (`🎨 МК команди` at `src/bot.ts:962`, `👥 Моя команда` at `src/bot.ts:936`)

Registrations and the member list both come from Mongo. In `handleTeamRoster`, the change is a single line — replace `const { visitors } = await loadVisitors();` with:

```typescript
  const visitors = await getVisitorsMongo();
```

The rest of the roster function (including the `isMeaningfulNeed` filtering) is unchanged. Accepted staleness: «Особливі потреби» in this view can lag Sheets until the next `/syncvisitors`; the field rarely changes after registration, and the doctor's QR-scan view still reads the raw cell live from Sheets.

In `handleTeamMc`:

```typescript
async function handleTeamMc(ctx: Context) {
  const teams = await myLedTeams(ctx.from!.id);
  if (!teams) return replyRoleRevoked(ctx, M.notLeader);
  const [schedule, mcs, regsRaw, visitors] = await Promise.all([
    getMCSchedule(),
    getMasterclasses(),
    getRegistrations(),
    getVisitorsMongo(),
  ]);
  const slots = todaySlots(schedule);
  if (slots.length === 0) return ctx.reply(M.noMasterclassesToday);
  const regs = asMCRegistrations(regsRaw);
  // …the loop body stays exactly as it is, operating on `visitors` and `regs`…
}
```

The `for (const team of teams)` loop and everything inside it is unchanged.

- [ ] **Step 8: Rewrite `myOccurrencesToday`** (`src/bot.ts:1014`)

Catalog and schedule from Mongo; the `MCResponsible` role check stays on Sheets (role tabs are out of scope):

```typescript
async function myOccurrencesToday(telegramId: number): Promise<MCOccurrence[] | null> {
  const { responsible } = await loadResponsible();
  const mine = findResponsibleByTelegramId(responsible, telegramId);
  if (mine.length === 0) return null;
  const myIds = [...new Set(mine.map((r) => r.mcId))];
  const [mcs, schedule] = await Promise.all([getMasterclasses(), getMCSchedule()]);
  const occ: MCOccurrence[] = [];
  for (const s of todaySlots(schedule)) {
    for (const id of s.mcIds) {
      if (!myIds.includes(id)) continue;
      const mc = mcs.find((m) => m.id === id);
      if (mc) occ.push({ date: s.date, slot: s.slot, mc });
    }
  }
  return occ;
}
```

- [ ] **Step 9: Rewrite `handleMcAttendees`** (`👥 Учасники МК`, `src/bot.ts:1033`)

Mongo registrations store no name, so names are joined from the visitors mirror; an unresolvable ID renders `M.mcAttendeeUnknown` instead of silently disappearing:

```typescript
async function handleMcAttendees(ctx: Context) {
  const occ = await myOccurrencesToday(ctx.from!.id);
  if (occ === null) return replyRoleRevoked(ctx, M.notResponsible);
  if (occ.length === 0) return ctx.reply(M.noMyMcToday);
  const [regsRaw, visitors] = await Promise.all([getRegistrations(), getVisitorsMongo()]);
  const regs = asMCRegistrations(regsRaw);
  const nameById = new Map(
    visitors.filter((v) => v.telegramId).map((v) => [v.telegramId, v.name]),
  );
  const lines: string[] = [];
  for (const o of occ) {
    const taken = activeRegs(regs, o.date, o.slot, o.mc.id);
    lines.push(M.mcAttendeesHeader(o.mc.title, o.slot, o.mc.place, taken.length, o.mc.capacity));
    if (taken.length === 0) lines.push(M.mcNoAttendees);
    for (const r of taken)
      lines.push(`• ${nameById.get(r.telegramId) ?? M.mcAttendeeUnknown(r.telegramId)}`);
    lines.push("");
  }
  return ctx.reply(lines.join("\n").trimEnd());
}
```

- [ ] **Step 10: Rewrite `notifyOccurrence`** (`src/bot.ts:1064`)

Only the registration fetch changes — messages are sent by `telegramId`, no names needed:

```typescript
  const regs = asMCRegistrations(await getRegistrations());
  const taken = activeRegs(regs, o.date, o.slot, o.mc.id);
```

The rest of the function is unchanged.

- [ ] **Step 11: Rewrite `renderCaught`** (`src/bot.ts:1124`)

Same pattern: Mongo registrations plus a name join from the mirror:

```typescript
  const [regsRaw, catches, visitors] = await Promise.all([
    getRegistrations(),
    loadCatches(),
    getVisitorsMongo(),
  ]);
  const regs = asMCRegistrations(regsRaw);
  const nameById = new Map(
    visitors.filter((v) => v.telegramId).map((v) => [v.telegramId, v.name]),
  );
```

…and where the caught list is built, replace `r.name` with `nameById.get(r.telegramId) ?? M.mcAttendeeUnknown(r.telegramId)`.

- [ ] **Step 12: Wrap the registrations**

Wherever these handlers are registered (`bot.command`, `bot.hears`, `bot.callbackQuery`), wrap the Mongo-backed ones: `bot.command("mc", mongoGuarded(handleMasterclasses))`, `bot.hears(BTN.masterclasses, mongoGuarded(handleMasterclasses))`, and likewise for `handleMyRegs`, `handleTeamMc`, `handleTeamRoster`, `handleMcAttendees`, the `mn:` callback, and `/notifymc`/`/caught` command bodies.

- [ ] **Step 13: Update the imports in `src/bot.ts`**

Add:

```typescript
import {
  asMCRegistrations,
  getMasterclasses,
  getMCSchedule,
  getMCTopics,
  getRegistrations,
  registerMongo,
  syncMCFromSheets,
  unregisterMongo,
} from "./mc-store";
import { findVisitorByTelegramIdMongo, getVisitorsMongo, syncVisitorsFromSheets, upsertVisitorMongo } from "./visitor-store";
```

Then remove now-unused imports from `./masterclasses`: `loadMasterclasses`, `loadMCSchedule`, `loadMCTabRows`, `loadMCTopics`, `loadMCRegistrations`, `register`, `unregister`. Keep `activeRegs`, `buildSlotButtons`, `topicLines`, `todaySlots`, `splitResponsibleNames`, `Masterclass`. Let `npm run typecheck` tell you exactly which are unused.

- [ ] **Step 14: Update the reminder cron**

In `api/cron/mc-reminder.ts`, the whole data fetch moves to Mongo — including recipients, which come from the visitors mirror (checked in + linked, same filter as today). The cron then costs **zero** Sheets reads:

```typescript
  // 1. Schedule comes from Mongo — no Sheets reads anywhere in this cron.
  const schedule = await getMCSchedule();

  // 2. Check if we have any matching slots today. If not, exit immediately.
  const slots = todaySlots(schedule).filter((s) => s.slot.startsWith(before));
  if (slots.length === 0) return res.json({ sent: 0, reason: "no matching slot today" });

  // 3. Only fetch the rest if there is actually a slot to process.
  const [mcs, regsRaw, visitors, topics] = await Promise.all([
    getMasterclasses(),
    getRegistrations(),
    getVisitorsMongo(),
    getMCTopics(),
  ]);
  const regs = asMCRegistrations(regsRaw);
```

The recipients block keeps its exact filter logic, reading from `visitors` (the mirror serves the same `Visitor` shape). Update the imports: keep `buildSlotButtons`, `hasActiveRegistrationForSlot`, `todaySlots`, `topicLines` from `../../src/masterclasses`; import `getMasterclasses`, `getMCSchedule`, `getMCTopics`, `getRegistrations`, `asMCRegistrations` from `../../src/mc-store` and `getVisitorsMongo` from `../../src/visitor-store`; drop `loadVisitors` and the `loadMC*` loaders.

- [ ] **Step 15: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 16: Commit**

```bash
git add src/bot.ts src/mc-store.ts src/messages.ts api/cron/mc-reminder.ts
git commit -m "feat(mc): serve the whole masterclass path from Mongo

Listing, registering, cancelling, 'Мої реєстрації', 'Учасники МК',
'МК команди', 'Моя команда', /notifymc, /caught and the reminder cron now
cost zero Sheets read requests. Attendee names are joined from the visitors mirror; the
check-in gate checks Mongo with a Sheets fallback on miss. Every
Mongo-backed handler is wrapped so an outage replies 'спробуйте за хвилину'
instead of becoming a 500 that Telegram redelivers. EventRegs is no longer
read or written."
```

---

### Task 6: Camp schedule from Mongo and `/syncschedule`

**Files:**
- Modify: `src/schedule.ts:55-94`
- Modify: `src/mc-store.ts` (add schedule sync/read)
- Modify: `src/messages.ts`, `src/bot.ts` (add `/syncschedule`)

**Interfaces:**
- Produces: `syncCampSchedule(): Promise<number>` (returns slot count) and `getCampSlots(): Promise<{ time: string; activity: string }[]>` from `src/mc-store.ts`.
- `loadTodaySchedule()` keeps its exact existing signature and `ScheduleResult` shape.

- [ ] **Step 1: Add the schedule store functions**

Append to `src/mc-store.ts` (merge imports):

```typescript
import { config } from "./config";
import { getRowsFromSpreadsheet } from "./sheets";

const GRID_TAB = "3.Розклад табору 2026";
const CAMP_SCHEDULE_ID = "grid";

/** Imports the badge-grid schedule into Mongo. The grid applies no per-date filtering —
 *  the same slot list serves every camp day — so it is a single document. */
export async function syncCampSchedule(): Promise<number> {
  if (!config.gridSheetId) return 0;
  const rows = await getRowsFromSpreadsheet(config.gridSheetId, GRID_TAB);
  const slots: { time: string; activity: string }[] = [];
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const time = (row[8] ?? "").trim();
    const activity = (row[9] ?? "").trim();
    if (!time || !activity) continue;
    slots.push({ time, activity });
  }
  const col = (await db()).collection(COLLECTIONS.campSchedule);
  await col.deleteMany({});
  if (slots.length) await col.insertOne({ _id: CAMP_SCHEDULE_ID, slots } as never);
  return slots.length;
}

export async function getCampSlots(): Promise<{ time: string; activity: string }[]> {
  const doc = await (await db()).collection(COLLECTIONS.campSchedule).findOne({});
  return ((doc?.slots as { time: string; activity: string }[]) ?? []);
}
```

- [ ] **Step 2: Swap the fetch in `schedule.ts`**

In `src/schedule.ts`, change the import at line 2 from:

```typescript
import { getRowsFromSpreadsheet } from "./sheets";
```

to:

```typescript
import { getCampSlots } from "./mc-store";
```

Then replace lines 67–80 (the fetch and parse) with:

```typescript
  const cached = await getCampSlots();
  const slots: ScheduleSlot[] = cached.map((s) => ({
    time: s.time,
    activity: s.activity,
    isCurrent: false,
  }));

  if (slots.length === 0) return { status: "unavailable" };
```

Delete the now-unused `GRID_TAB` constant at the top of `schedule.ts` — it lives in `mc-store.ts` now. Everything else in the function, including the `isCurrent` highlighting, stays exactly as it is. Wrap the `🗓 Розклад` handler registration in `mongoGuarded` too.

- [ ] **Step 3: Add the message and command**

In `src/messages.ts`, after `visitorsSynced`:

```typescript
  scheduleSynced: (slots: number) => `Розклад табору оновлено ✅\nПунктів: ${slots}.`,
```

In `src/bot.ts`, next to `/syncmc`:

```typescript
bot.command("syncschedule", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  try {
    return ctx.reply(M.scheduleSynced(await syncCampSchedule()));
  } catch (err) {
    console.error("syncschedule failed", err);
    return ctx.reply(M.syncFailed);
  }
});
```

Add `syncCampSchedule` to the `./mc-store` import list.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/schedule.ts src/mc-store.ts src/messages.ts src/bot.ts
git commit -m "feat(schedule): serve the camp schedule from Mongo

The badge grid is read-only, unchanged for the whole camp, and pressed many
times a day. It applies no per-date filtering, so it caches as a single
document; dayLabel, isToday and isCurrent stay computed per request."
```

---

### Task 7: Index creation, docs, and deploy

**Files:**
- Modify: `src/bot.ts` (call `ensureIndexes` from `/syncmc`)
- Modify: `CLAUDE.md`
- Modify: `.env.example` if present, otherwise `README.md`

- [ ] **Step 1: Create indexes during `/syncmc`**

The unique index must exist before the first registration. Creating it in `/syncmc` means it is in place as soon as an admin imports the catalog, with no module-scope work. In `src/bot.ts`, inside the `/syncmc` handler, before `syncMCFromSheets()`:

```typescript
    await ensureIndexes();
```

Add `ensureIndexes` to the `./mc-store` import list. Re-running `/syncmc` must not error — `createIndex` is idempotent for an identical spec.

- [ ] **Step 2: Document the environment variables**

Add to `README.md` (or `.env.example` if that file exists) under the environment section:

```
MONGO_URI=mongodb+srv://...      # operational store; unset = Sheets only
MONGO_DB=discovery_camp          # optional, defaults to discovery_camp
```

- [ ] **Step 3: Update CLAUDE.md**

In the "Google Sheets schema" section, mark `EventRegs` as retired:

```markdown
- **`EventRegs`** — retired. Registrations live in MongoDB (`registrations` collection);
  this tab is no longer read or written. Left in place so pre-Mongo rows stay readable.
```

Add to "Key design notes":

```markdown
- **MongoDB is the operational store for masterclasses** (`src/mongo.ts`, `src/mc-store.ts`,
  `src/visitor-store.ts`). The catalog, schedule and topics are imported from `MCSchedule`
  by `/syncmc`; the visitors mirror from the Visitors tab by `/syncvisitors` (telegramId
  lookups only — payment and doctor status are never mirrored, the doctor gate reads Sheets
  live); the camp schedule from the badge grid by `/syncschedule`. Registrations live only
  in Mongo, where a unique partial index on `(date, slot, telegramId)` over `active: true`
  makes one-registration-per-slot a database guarantee — the read-count-append race the
  sheet version had is gone. Check-in write-throughs to the mirror are best-effort. The
  Mongo client is created once per lambda and never at module scope. Every Mongo-backed
  handler goes through `mongoGuarded` (`src/bot.ts`) so an outage replies «спробуйте за
  хвилину» instead of a 500 that Telegram redelivers. `MONGO_URI` unset means Mongo is not
  configured; `/syncmc` will fail loudly.
```

Also remove the sentence in "Key design notes" that reads "**No database transactions**: concurrent registrations have a small race window — acceptable for camp scale." It is no longer true for registrations.

- [ ] **Step 4: Commit**

```bash
git add src/bot.ts CLAUDE.md README.md
git commit -m "docs: record the Mongo store and retire EventRegs

Indexes are created by /syncmc so they exist before the first registration
without any module-scope work. Drops the documented registration race,
which the unique partial index now prevents."
```

- [ ] **Step 5: Deploy and verify against production**

This is the step that matters — with no automated tests, this checklist IS the verification. **Do all of it before the 13:00 Kyiv cron firing** (`0 10 * * *` UTC in `vercel.json`).

1. Set `MONGO_URI` and `MONGO_DB` in the Vercel project environment (Production).
2. Merge to `main` and deploy: `npx vercel --prod`, then `npm run set-webhook` if the URL changed.
3. In Telegram, as an admin, run `/syncmc`. Expect counts matching the `MCSchedule` tab.
4. Run `/syncvisitors`. Expect a count matching the Visitors tab.
5. Run `/syncschedule`. Expect a count matching the badge grid.
6. Press `🗓 Розклад` — today's schedule renders with the current slot highlighted.
7. Press `🎨 Майстер-класи` and confirm today's slots and capacities render.
8. Register for a masterclass, confirm the confirmation message, press `📋 Мої реєстрації`, and confirm your own name appears in `👥 Учасники МК` (as a responsible person, or ask one to check).
9. As a leader (or ask one): `🎨 МК команди` shows the team with your registration listed, and `👥 Моя команда` renders the roster (names, age, room, needs) from the mirror.
10. Cancel the registration; confirm in Mongo that `registrations` holds one document with `active: false`, and that the slot can be re-registered.
11. Simulate the un-checked-in path if convenient: an account with no Visitors link tapping a register button gets `mustCheckInFirst`.

If `/syncmc` has not been run, the catalog is empty and every masterclass button silently vanishes from the list — the failure is quiet, which is exactly why it needs checking by hand rather than waiting for a user report. Same for `/syncvisitors`: without it, attendee lists render `невідомий учасник` and the check-in gate falls back to Sheets reads.

---

## Self-review notes

**Spec coverage.** Rollout steps 1–2, the camp schedule, and a scoped slice of step 3 (visitors mirror for telegramId lookups) are covered. Spec sections deliberately **not** covered, as agreed: check-in name search from Mongo, `loadRoleContext`, role tabs, `/syncroles`, videos, `/syncvideo`, team rename and the `teams` collection. Payment and doctor gates read Sheets live, always.

**All seven registration readers are cut over** — the four beyond the obvious ones (`👥 Учасники МК`, `📣`/`/notifymc`, `🎨 МК команди`, `/caught`) would otherwise silently show "nobody registered" the day after cutover, since nothing writes `EventRegs` anymore.

**Failure behaviour is implemented, not just specified.** `mongoGuarded` turns a Mongo outage into a polite reply instead of an HTTP 500 redelivery loop — the spec's "Failure behaviour" section made this a requirement precisely because there is no global `bot.catch`.

**Capacity is exact under concurrency.** The first design compensated after insert with an `_id`-sorted rollback; review showed ObjectIds from different lambdas in the same second sort by random bytes, so racers could disagree about who overflowed and a burst could still oversell. Replaced (2026-08-03, approved) with an atomic per-(date, slot, mcId) seat counter: `findOneAndUpdate({ taken: { $lt: capacity } }, { $inc: { taken: 1 } })` is atomic on one document, so overselling is impossible by construction. The only drift mode is a leaked seat (undersell) from a crash between seat-take and insert; `/syncmc` rebuilds counters from active registrations. The duplicate guarantee is exact regardless, because the unique index enforces it.

**Staleness windows, accepted.** The visitors mirror can lag Sheets between syncs; check-in write-through plus the Sheets fallback on gate misses cover the realistic cases (check-in is essentially complete this camp). The `👥 Моя команда` roster reads the mirror too (decision 2026-08-03) — «Особливі потреби» can lag until the next `/syncvisitors`, accepted because the field rarely changes after registration and the doctor's QR-scan view still reads Sheets live. Only the payment and doctor gates are never served from the mirror.
