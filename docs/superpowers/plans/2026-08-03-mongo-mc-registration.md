# Masterclass Registration on MongoDB — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the masterclass path and the camp schedule to zero Google Sheets read requests, and make registration capacity race-free, before the next `mc-reminder` cron firing.

**Architecture:** MongoDB becomes the store for the masterclass catalog, schedule, topics, registrations, and a cached copy of the badge-grid camp schedule. Sheets stays the source of truth for the catalog and grid, imported by admin commands (`/syncmc`, `/syncschedule`). Registrations live only in Mongo, where a unique partial index makes "one active registration per slot" a database guarantee rather than a read-count-append race. The `EventRegs` tab is retired.

**Tech Stack:** TypeScript, grammY, `mongodb` Node driver (new dependency), Vercel serverless, `tsx` for tests.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-03-mongo-operational-store-design.md`. This plan implements rollout steps 1–2 plus the camp schedule only. Visitors, role tabs, videos and team rename are explicitly **out of scope**.
- `api/bot.ts` has `maxDuration: 10` (`vercel.json`). Mongo connect and query timeouts must stay well inside that budget.
- Vercel spawns many concurrent lambdas. The Mongo client MUST be created once at module scope and reused; never per request.
- **No expensive work at module scope** (CLAUDE.md). Creating the client object is lazy and cheap; do not `await connect()` at import time.
- There is **no test framework** in this repo. Tests are standalone `.mts` scripts run with `npx tsx`, using stubbed drivers — follow the existing pattern (see "Testing setup" below).
- All user-facing strings go in `src/messages.ts` in the `M` object. Ukrainian only.
- Admin commands are gated with `isAdmin(ctx.from?.id, admins)` and reply `M.notAdmin` otherwise.
- Do not add a global `bot.catch` (CLAUDE.md documents this as deliberate).
- Never leave a raw NUL byte or other control character in source. `npm run typecheck` will not catch it; `git diff --stat` reporting a `.ts` file as `Bin` is the signal.

## Testing setup

Tests live in `tests/` as `.mts` files and are run with `npx tsx tests/<name>.test.mts`. They must exit non-zero on failure. Each stubs its dependencies — **no test may touch a live MongoDB or Google Sheets**.

Three suites already exist as scratch scripts and must be kept green. Task 1 moves them into `tests/` so there is one place to run everything.

---

### Task 1: Test harness and existing suites

Establish `tests/` and a single command that runs everything, so later tasks have somewhere to put tests and a regression signal.

**Files:**
- Create: `tests/lib/assert.mts`
- Create: `tests/run-all.mts`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Produces: `check(label: string, actual: unknown, expected: unknown): void` and `report(): never` from `tests/lib/assert.mts`, used by every later test.

- [ ] **Step 1: Write the shared assertion helper**

Create `tests/lib/assert.mts`:

```typescript
let failures = 0;

/** Deep-equality check by JSON shape. Prints one line per check. */
export function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}

/** Prints the summary and exits with the right status. Call at the end of every suite. */
export function report(): never {
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} CHECK(S) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Add the runner**

Create `tests/run-all.mts`:

```typescript
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = new URL(".", import.meta.url).pathname;
const suites = readdirSync(dir).filter((f) => f.endsWith(".test.mts")).sort();

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  try {
    execFileSync("npx", ["tsx", join(dir, suite)], { stdio: "inherit" });
  } catch {
    failed++;
  }
}
console.log(failed === 0 ? `\n${suites.length} suite(s) passed.` : `\n${failed} suite(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 3: Add the test script**

In `package.json`, add to `scripts`:

```json
"test": "tsx tests/run-all.mts"
```

- [ ] **Step 4: Run it to verify it reports zero suites**

Run: `npm test`
Expected: PASS, `0 suite(s) passed.` — no `.test.mts` files exist yet.

- [ ] **Step 5: Commit**

```bash
git add tests/lib/assert.mts tests/run-all.mts package.json
git commit -m "test: add a test harness and runner

There was no test framework; suites were ad-hoc scratch scripts. This gives
them one home and one command, so later work has a regression signal."
```

---

### Task 2: Mongo connection module

A single shared client, safe for serverless.

**Files:**
- Create: `src/mongo.ts`
- Modify: `src/config.ts:20` (add `mongoUri`, `mongoDb`)
- Modify: `package.json` (add `mongodb` dependency)
- Test: `tests/mongo-config.test.mts`

**Interfaces:**
- Consumes: `config` from `src/config.ts`.
- Produces:
  - `db(): Promise<Db>` — the shared database handle, connecting on first use.
  - `mongoEnabled(): boolean` — whether `MONGO_URI` is configured.
  - `COLLECTIONS` — `{ masterclasses: "masterclasses", mcSchedule: "mcSchedule", mcTopics: "mcTopics", registrations: "registrations", campSchedule: "campSchedule" }`.

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

/** Test seam: lets suites inject a stub database without a live server. */
export function __setDbForTests(stub: Db | null): void {
  connecting = stub ? Promise.resolve(stub) : null;
}
```

- [ ] **Step 4: Write the test**

Create `tests/mongo-config.test.mts`:

```typescript
process.env.BOT_TOKEN = "x";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "x@example.com";
process.env.GOOGLE_PRIVATE_KEY = "x";
process.env.SHEET_ID = "SHEET_MAIN";
process.env.MONGO_URI = "";

import { check, report } from "./lib/assert.mts";

const P = "/Users/serhii/projects/discovery-camp/src";
const { mongoEnabled, db, COLLECTIONS } = await import(`${P}/mongo.ts`);

console.log("\nMongo module with MONGO_URI unset:");
check("mongoEnabled() is false", mongoEnabled(), false);

let threw = false;
try {
  await db();
} catch {
  threw = true;
}
check("db() throws rather than hanging", threw, true);
check("collection names are stable", Object.keys(COLLECTIONS).sort(), [
  "campSchedule", "masterclasses", "mcSchedule", "mcTopics", "registrations",
]);

report();
```

- [ ] **Step 5: Run the test**

Run: `npx tsx tests/mongo-config.test.mts`
Expected: PASS, all three checks ok.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add src/mongo.ts src/config.ts package.json package-lock.json tests/mongo-config.test.mts
git commit -m "feat(mongo): add a serverless-safe shared client

One client per lambda instance, created lazily and reused. Vercel spawns
many concurrent instances, so a per-request client would exhaust the Atlas
connection limit; connect() is not awaited at module scope because every
cold start would pay for it inside a 10s budget."
```

---

### Task 3: Mongo-backed masterclass catalog and `/syncmc`

Import the `MCSchedule` tab into Mongo and read the catalog from there.

**Files:**
- Create: `src/mc-store.ts`
- Modify: `src/messages.ts` (add sync messages)
- Modify: `src/bot.ts` (add `/syncmc`)
- Test: `tests/mc-store.test.mts`

**Interfaces:**
- Consumes: `db()`, `COLLECTIONS` from `src/mongo.ts`; `Masterclass`, `SlotSchedule`, `loadMCTabRows`, `loadMasterclasses`, `loadMCSchedule`, `loadMCTopics` from `src/masterclasses.ts`.
- Produces:
  - `syncMCFromSheets(): Promise<{ masterclasses: number; slots: number; topics: number }>`
  - `getMasterclasses(): Promise<Masterclass[]>`
  - `getMCSchedule(): Promise<SlotSchedule[]>`
  - `getMCTopics(): Promise<Map<string, string>>` — keyed `"<date>|<mcId>"`, matching the existing sheet-backed shape.

- [ ] **Step 1: Write the failing test**

Create `tests/mc-store.test.mts`:

```typescript
process.env.BOT_TOKEN = "x";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "x@example.com";
process.env.GOOGLE_PRIVATE_KEY = "x";
process.env.SHEET_ID = "SHEET_MAIN";
process.env.MONGO_URI = "mongodb://stub";

import { check, report } from "./lib/assert.mts";
import { google } from "googleapis";

// MCSchedule tab: schedule block on the left, catalog block to the right.
const MC_TAB = [
  ["Date", "Slot", "MC IDs", "", "№", "Назва", "Відповідальний", "Місце проведення", "Кількість учасників"],
  ["2026-08-04", "12:00-13:00", "1,2", "", "1.", "Малювання", "Оля", "Намет 1", "10"],
  ["2026-08-04", "14:00-15:00", "2", "", "2.", "Гончарство", "Іван", "Намет 2", "без обмежень"],
];

(google as unknown as { sheets: unknown }).sheets = () => ({
  spreadsheets: {
    values: {
      batchGet: async ({ ranges }: { ranges: string[] }) => ({
        data: { valueRanges: ranges.map(() => ({ values: MC_TAB })) },
      }),
    },
  },
});

// Minimal in-memory stand-in for the collections mc-store uses.
function makeStubDb() {
  const store = new Map<string, Record<string, unknown>[]>();
  return {
    store,
    collection(name: string) {
      if (!store.has(name)) store.set(name, []);
      return {
        async deleteMany() { store.set(name, []); },
        async insertMany(docs: Record<string, unknown>[]) { store.get(name)!.push(...docs); },
        find() {
          return { async toArray() { return store.get(name)!; } };
        },
      };
    },
  };
}

const P = "/Users/serhii/projects/discovery-camp/src";
const mongo = await import(`${P}/mongo.ts`);
const stub = makeStubDb();
mongo.__setDbForTests(stub as never);

const { syncMCFromSheets, getMasterclasses, getMCSchedule } = await import(`${P}/mc-store.ts`);

console.log("\n/syncmc imports the MCSchedule tab:");
const counts = await syncMCFromSheets();
check("masterclasses imported", counts.masterclasses, 2);
check("schedule slots imported", counts.slots, 2);

console.log("\nCatalog reads come from Mongo:");
const mcs = await getMasterclasses();
check("two masterclasses", mcs.length, 2);
check("title parsed", mcs[0].title, "Малювання");
check("place parsed", mcs[0].place, "Намет 1");
check("numeric capacity", mcs[0].capacity, 10);
check("'без обмежень' is unlimited", mcs[1].capacity, 0);

const slots = await getMCSchedule();
check("slot ids parsed", slots[0].mcIds, ["1", "2"]);

console.log("\nRe-syncing replaces rather than duplicating:");
await syncMCFromSheets();
check("still two masterclasses", (await getMasterclasses()).length, 2);

report();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx tests/mc-store.test.mts`
Expected: FAIL — `Cannot find module .../src/mc-store.ts`.

- [ ] **Step 3: Write the store**

Create `src/mc-store.ts`:

```typescript
import { Masterclass, SlotSchedule, loadMCTabRows, loadMasterclasses, loadMCSchedule, loadMCTopics } from "./masterclasses";
import { COLLECTIONS, db } from "./mongo";

/** Re-imports the MCSchedule tab into Mongo. Replaces rather than upserts, so a row
 *  deleted from the sheet disappears here too. Sheets stays the source of truth for
 *  the catalog; Mongo is the copy every request reads. */
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx tests/mc-store.test.mts`
Expected: PASS, all nine checks ok.

- [ ] **Step 5: Add the messages**

In `src/messages.ts`, after the `menusSynced` entry, add:

```typescript
  mcSynced: (mcs: number, slots: number, topics: number) =>
    `Каталог МК оновлено ✅\nМайстер-класів: ${mcs}, слотів: ${slots}, тем: ${topics}.`,
  syncFailed: "Не вдалося синхронізувати. Спробуйте ще раз за хвилину.",
```

- [ ] **Step 6: Add the `/syncmc` command**

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

- [ ] **Step 7: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all suites pass.

- [ ] **Step 8: Commit**

```bash
git add src/mc-store.ts src/messages.ts src/bot.ts tests/mc-store.test.mts
git commit -m "feat(mc): import the masterclass catalog into Mongo via /syncmc

Sheets stays the source of truth for the catalog; Mongo is the copy every
request reads. Sync replaces rather than upserts so a row deleted from the
sheet disappears here too."
```

---

### Task 4: Registrations in Mongo with atomic capacity

The core of the change. Registration becomes a Mongo insert guarded by a unique index.

**Files:**
- Modify: `src/mc-store.ts` (add registration functions)
- Test: `tests/mc-registration.test.mts`

**Interfaces:**
- Consumes: `db()`, `COLLECTIONS`, `getMasterclasses()`.
- Produces, mirroring the existing sheet-backed signatures in `src/masterclasses.ts` so call sites change as little as possible:
  - `ensureIndexes(): Promise<void>`
  - `MongoRegistration` — `{ date: string; slot: string; mcId: string; telegramId: string; active: boolean }`
  - `getRegistrations(): Promise<MongoRegistration[]>`
  - `registerMongo(date: string, slot: string, mcId: string, capacity: number, telegramId: number): Promise<RegisterResult>` — `RegisterResult` is the existing `"ok" | "full" | "already" | "slot_taken"` from `src/masterclasses.ts`
  - `unregisterMongo(date: string, slot: string, mcId: string, telegramId: number): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `tests/mc-registration.test.mts`. The stub models the unique partial index, because that guarantee is the whole point of this task:

```typescript
process.env.BOT_TOKEN = "x";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "x@example.com";
process.env.GOOGLE_PRIVATE_KEY = "x";
process.env.SHEET_ID = "SHEET_MAIN";
process.env.MONGO_URI = "mongodb://stub";

import { check, report } from "./lib/assert.mts";

interface Doc { date: string; slot: string; mcId: string; telegramId: string; active: boolean }

/** In-memory collection that enforces the unique partial index on
 *  (date, slot, telegramId) over { active: true }, the way Mongo would. */
function makeStubDb() {
  let docs: Doc[] = [];
  return {
    reset() { docs = []; },
    all() { return docs; },
    collection() {
      return {
        async createIndex() {},
        find(filter: Partial<Doc> = {}) {
          return {
            async toArray() {
              return docs.filter((d) =>
                Object.entries(filter).every(([k, v]) => (d as never as Record<string, unknown>)[k] === v));
            },
          };
        },
        async countDocuments(filter: Partial<Doc>) {
          return docs.filter((d) =>
            Object.entries(filter).every(([k, v]) => (d as never as Record<string, unknown>)[k] === v)).length;
        },
        async findOne(filter: Partial<Doc>) {
          return docs.find((d) =>
            Object.entries(filter).every(([k, v]) => (d as never as Record<string, unknown>)[k] === v)) ?? null;
        },
        async insertOne(doc: Doc) {
          const clash = docs.some((d) =>
            d.active && doc.active && d.date === doc.date && d.slot === doc.slot &&
            d.telegramId === doc.telegramId);
          if (clash) {
            throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
          }
          docs.push({ ...doc });
          return { insertedId: "x" };
        },
        async updateOne(filter: Partial<Doc>, update: { $set: Partial<Doc> }) {
          const target = docs.find((d) =>
            Object.entries(filter).every(([k, v]) => (d as never as Record<string, unknown>)[k] === v));
          if (!target) return { modifiedCount: 0 };
          Object.assign(target, update.$set);
          return { modifiedCount: 1 };
        },
      };
    },
  };
}

const P = "/Users/serhii/projects/discovery-camp/src";
const mongo = await import(`${P}/mongo.ts`);
const stub = makeStubDb();
mongo.__setDbForTests(stub as never);

const { registerMongo, unregisterMongo, getRegistrations } = await import(`${P}/mc-store.ts`);

const D = "2026-08-04", S = "12:00-13:00";

console.log("\nHappy path:");
stub.reset();
check("first registration succeeds", await registerMongo(D, S, "1", 10, 111), "ok");
check("one active registration stored", (await getRegistrations()).length, 1);

console.log("\nDuplicate and slot rules:");
check("same MC again is 'already'", await registerMongo(D, S, "1", 10, 111), "already");
check("different MC same slot is 'slot_taken'", await registerMongo(D, S, "2", 10, 111), "slot_taken");

console.log("\nCapacity is enforced:");
stub.reset();
check("seat 1 of 1", await registerMongo(D, S, "1", 1, 111), "ok");
check("seat 2 of 1 is 'full'", await registerMongo(D, S, "1", 1, 222), "full");
check("unlimited capacity accepts anyone", await registerMongo(D, S, "9", 0, 333), "ok");

console.log("\nTwo people racing for the last seat — exactly one wins:");
stub.reset();
await registerMongo(D, S, "1", 3, 1);
await registerMongo(D, S, "1", 3, 2);
const raced = await Promise.all([
  registerMongo(D, S, "1", 3, 777),
  registerMongo(D, S, "1", 3, 888),
]);
check("exactly one 'ok'", raced.filter((r) => r === "ok").length, 1);
check("the other is refused", raced.filter((r) => r !== "ok").length, 1);
check("capacity of 3 not exceeded", (await getRegistrations()).filter((r) => r.active).length, 3);

console.log("\nCancelling frees the slot:");
stub.reset();
await registerMongo(D, S, "1", 10, 111);
check("cancel succeeds", await unregisterMongo(D, S, "1", 111), true);
check("cancelling twice is false", await unregisterMongo(D, S, "1", 111), false);
check("can re-register the same slot", await registerMongo(D, S, "2", 10, 111), "ok");

report();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx tests/mc-registration.test.mts`
Expected: FAIL — `registerMongo is not a function`.

- [ ] **Step 3: Implement the registration functions**

Append to `src/mc-store.ts`:

```typescript
import { RegisterResult } from "./masterclasses";
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
  const col = (await db()).collection(COLLECTIONS.registrations);
  await col.createIndex(
    { date: 1, slot: 1, telegramId: 1 },
    { unique: true, partialFilterExpression: { active: true } },
  );
  await col.createIndex({ date: 1, slot: 1, mcId: 1 });
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
  if (existing) return existing.mcId === mcId ? "already" : "slot_taken";

  if (capacity > 0) {
    const taken = await col.countDocuments({ date, slot, mcId, active: true });
    if (taken >= capacity) return "full";
  }

  try {
    await col.insertOne({
      date, slot, mcId, telegramId: id, active: true,
      registeredAt: nowStamp(), cancelledAt: "",
    } as never);
  } catch (err) {
    // The unique index rejected a concurrent insert for the same person and slot.
    // This is the race the sheet-backed version could not close.
    if ((err as { code?: number }).code === 11000) {
      const now = await col.findOne({ date, slot, telegramId: id, active: true });
      return now?.mcId === mcId ? "already" : "slot_taken";
    }
    throw err;
  }

  // Capacity is checked before the insert, so a burst can still overshoot by the number
  // of inserts in flight. Re-check afterwards and roll back the losers, which keeps the
  // seat count exact without a transaction.
  if (capacity > 0) {
    const taken = await col.countDocuments({ date, slot, mcId, active: true });
    if (taken > capacity) {
      const mine = await col.findOne({ date, slot, telegramId: id, active: true });
      const all = await col.find({ date, slot, mcId, active: true }).toArray();
      const overflow = all.slice(capacity).some((d) => String(d.telegramId) === id);
      if (mine && overflow) {
        await col.updateOne(
          { date, slot, telegramId: id, active: true },
          { $set: { active: false, cancelledAt: nowStamp() } },
        );
        return "full";
      }
    }
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
  return res.modifiedCount > 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx tests/mc-registration.test.mts`
Expected: PASS, all thirteen checks ok — including "exactly one 'ok'" in the race.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/mc-store.ts tests/mc-registration.test.mts
git commit -m "feat(mc): registrations in Mongo with atomic capacity

A unique partial index on (date, slot, telegramId) over active documents
makes one-registration-per-slot a database guarantee. Capacity is checked
before insert and re-checked after, rolling back inserts that lost a race,
so a burst cannot oversell a slot the way the read-count-append path could."
```

---

### Task 5: Point the masterclass handlers at Mongo

Swap the call sites. This is the task that actually removes the reads.

**Files:**
- Modify: `src/bot.ts` — `handleMasterclasses`, `handleMyRegs`, the `mcreg:` and `mcunreg:` callbacks
- Modify: `api/cron/mc-reminder.ts:33-46`
- Test: `tests/mc-handlers.test.mts`

**Interfaces:**
- Consumes: `getMasterclasses`, `getMCSchedule`, `getMCTopics`, `getRegistrations`, `registerMongo`, `unregisterMongo` from `src/mc-store.ts`.
- Note: `buildSlotButtons`, `activeRegs`, `hasActiveRegistrationForSlot` and `topicLines` in `src/masterclasses.ts` are **pure functions over arrays** and stay unchanged. `buildSlotButtons` takes `MCRegistration[]`; `MongoRegistration` is structurally compatible for the fields it reads (`date`, `slot`, `mcId`, `telegramId`) except `cancelled`. Add a mapping helper rather than changing the pure functions.

- [ ] **Step 1: Write the failing test**

Create `tests/mc-handlers.test.mts`, asserting the thing that matters — zero Sheets requests:

```typescript
process.env.BOT_TOKEN = "123:FAKE";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "x@example.com";
process.env.GOOGLE_PRIVATE_KEY = "x";
process.env.SHEET_ID = "SHEET_MAIN";
process.env.MONGO_URI = "mongodb://stub";

import { check, report } from "./lib/assert.mts";
import { google } from "googleapis";

let sheetsRequests = 0;
(google as unknown as { sheets: unknown }).sheets = () => ({
  spreadsheets: {
    values: {
      batchGet: async ({ ranges }: { ranges: string[] }) => {
        sheetsRequests++;
        return { data: { valueRanges: ranges.map(() => ({ values: [] })) } };
      },
      update: async () => ({ data: {} }),
      append: async () => ({ data: {} }),
    },
  },
});

const TODAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv" }).format(new Date());

const data: Record<string, Record<string, unknown>[]> = {
  masterclasses: [
    { _id: "1", id: "1", title: "Малювання", responsible: "Оля", place: "Намет 1", capacity: 10 },
  ],
  mcSchedule: [{ _id: `${TODAY}|12:00-13:00`, date: TODAY, slot: "12:00-13:00", mcIds: ["1"] }],
  mcTopics: [],
  registrations: [],
};

function makeStubDb() {
  return {
    collection(name: string) {
      if (!data[name]) data[name] = [];
      const rows = () => data[name];
      const match = (d: Record<string, unknown>, f: Record<string, unknown>) =>
        Object.entries(f).every(([k, v]) => d[k] === v);
      return {
        async createIndex() {},
        find(f: Record<string, unknown> = {}) {
          return { async toArray() { return rows().filter((d) => match(d, f)); } };
        },
        async countDocuments(f: Record<string, unknown>) { return rows().filter((d) => match(d, f)).length; },
        async findOne(f: Record<string, unknown>) { return rows().find((d) => match(d, f)) ?? null; },
        async insertOne(doc: Record<string, unknown>) { rows().push(doc); return { insertedId: "x" }; },
        async updateOne(f: Record<string, unknown>, u: { $set: Record<string, unknown> }) {
          const t = rows().find((d) => match(d, f));
          if (!t) return { modifiedCount: 0 };
          Object.assign(t, u.$set);
          return { modifiedCount: 1 };
        },
        async deleteMany() { data[name] = []; },
        async insertMany(docs: Record<string, unknown>[]) { rows().push(...docs); },
      };
    },
  };
}

const P = "/Users/serhii/projects/discovery-camp/src";
const mongo = await import(`${P}/mongo.ts`);
mongo.__setDbForTests(makeStubDb() as never);

const { bot } = await import(`${P}/bot.ts`);

const apiCalls: string[] = [];
bot.botInfo = {
  id: 123, is_bot: true, first_name: "T", username: "b",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
} as never;
bot.api.config.use(async (_p, method: string) => {
  apiCalls.push(method);
  return { ok: true, result: { message_id: 1, date: 0, chat: { id: 5, type: "private" } } } as never;
});

async function run(label: string, update: unknown) {
  sheetsRequests = 0;
  apiCalls.length = 0;
  await bot.handleUpdate(update as never);
  console.log(`\n${label}\n  sheets requests: ${sheetsRequests}  api: ${apiCalls.join(", ")}`);
}

const cb = (data: string) => ({
  update_id: Math.floor(performance.now()),
  callback_query: {
    id: "q", from: { id: 555, is_bot: false, first_name: "U" }, chat_instance: "ci",
    message: { message_id: 1, date: 1, chat: { id: 555, type: "private" as const },
               from: { id: 123, is_bot: true, first_name: "T" }, text: "x" },
    data,
  },
});

await run("Listing masterclasses", {
  update_id: 1,
  message: { message_id: 2, date: 1, chat: { id: 555, type: "private" as const },
             from: { id: 555, is_bot: false, first_name: "U" }, text: "🎨 Майстер-класи" },
});
check("listing costs no Sheets request", sheetsRequests, 0);

await run("Registering", cb(`mcreg:${TODAY}:12:00-13:00:1`));
check("registering costs no Sheets request", sheetsRequests, 0);
check("registration stored in Mongo", data.registrations.filter((r) => r.active).length, 1);

await run("Cancelling", cb(`mcunreg:${TODAY}:12:00-13:00:1`));
check("cancelling costs no Sheets request", sheetsRequests, 0);
check("registration deactivated", data.registrations.filter((r) => r.active).length, 0);

report();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx tests/mc-handlers.test.mts`
Expected: FAIL — the handlers still call Sheets, so `sheetsRequests` is greater than 0.

- [ ] **Step 3: Add the registration adapter**

Append to `src/mc-store.ts`:

```typescript
import { MCRegistration } from "./masterclasses";

/** Adapts Mongo documents to the shape the pure helpers in masterclasses.ts expect
 *  (buildSlotButtons, activeRegs, hasActiveRegistrationForSlot). Those functions are
 *  array-only and stay unchanged; rowIndex and name are unused by them. */
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
```

- [ ] **Step 4: Rewrite `handleMasterclasses`**

In `src/bot.ts`, replace the body of `handleMasterclasses` with:

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

- [ ] **Step 5: Rewrite `handleMyRegs`**

Replace its body with:

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

- [ ] **Step 6: Rewrite the `mcreg:` callback**

Replace its body with — note there is no `loadVisitors()` call, which is what removes the last read:

```typescript
bot.callbackQuery(/^mcreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  if (date !== todayISO()) return safeAnswer(ctx, M.noMasterclassesToday);
  const [mcs, topics] = await Promise.all([getMasterclasses(), getMCTopics()]);
  const mc = mcs.find((m) => m.id === mcId);
  if (!mc) return safeAnswer(ctx);
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
});
```

- [ ] **Step 7: Rewrite the `mcunreg:` callback**

```typescript
bot.callbackQuery(/^mcunreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  if (date !== todayISO()) return safeAnswer(ctx, M.noMasterclassesToday);
  const mcs = await getMasterclasses();
  const mc = mcs.find((m) => m.id === mcId);
  const ok = await unregisterMongo(date, slot, mcId, ctx.from.id);
  await safeAnswer(ctx);
  if (ok && mc) await ctx.reply(M.mcUnregistered(mc.title, slot));
});
```

- [ ] **Step 8: Update the imports in `src/bot.ts`**

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
```

Then remove now-unused imports from `./masterclasses`: `loadMasterclasses`, `loadMCSchedule`, `loadMCTabRows`, `loadMCTopics`, `loadMCRegistrations`, `register`, `unregister`, `activeRegs`. Keep `buildSlotButtons`, `topicLines`, `todaySlots`, `splitResponsibleNames`, `hasActiveRegistrationForSlot`, `Masterclass`. Let `npm run typecheck` tell you exactly which are unused.

- [ ] **Step 9: Update the reminder cron**

In `api/cron/mc-reminder.ts`, replace lines 33–46 with:

```typescript
  // 1. Schedule and catalog come from Mongo — no Sheets reads for the masterclass data.
  const schedule = await getMCSchedule();

  // 2. Check if we have any matching slots today. If not, exit immediately.
  const slots = todaySlots(schedule).filter((s) => s.slot.startsWith(before));
  if (slots.length === 0) return res.json({ sent: 0, reason: "no matching slot today" });

  // 3. Only fetch the rest if there is actually a slot to process. Visitors still comes
  //    from Sheets — that is one read per cron run, not per participant.
  const [mcs, regsRaw, { visitors }, topics] = await Promise.all([
    getMasterclasses(),
    getRegistrations(),
    loadVisitors(),
    getMCTopics(),
  ]);
  const regs = asMCRegistrations(regsRaw);
```

Update that file's imports: keep `loadVisitors`, `buildSlotButtons`, `hasActiveRegistrationForSlot`, `todaySlots`, `topicLines`; import `getMasterclasses`, `getMCSchedule`, `getMCTopics`, `getRegistrations`, `asMCRegistrations` from `../../src/mc-store`; drop `loadMasterclasses`, `loadMCRegistrations`, `loadMCSchedule`, `loadMCTabRows`, `loadMCTopics`.

- [ ] **Step 10: Run the handler test**

Run: `npx tsx tests/mc-handlers.test.mts`
Expected: PASS — all five checks, with `sheets requests: 0` on every line.

- [ ] **Step 11: Typecheck and run everything**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all suites pass.

- [ ] **Step 12: Commit**

```bash
git add src/bot.ts src/mc-store.ts api/cron/mc-reminder.ts tests/mc-handlers.test.mts
git commit -m "feat(mc): serve the masterclass path from Mongo

Listing, registering, cancelling and 'Мої реєстрації' now cost zero Sheets
read requests; registration no longer reads Visitors because only the
Telegram ID is stored. The pure helpers in masterclasses.ts are unchanged
and fed through an adapter. EventRegs is no longer written."
```

---

### Task 6: Camp schedule from Mongo and `/syncschedule`

**Files:**
- Modify: `src/schedule.ts:55-94`
- Modify: `src/mc-store.ts` (add schedule sync/read)
- Modify: `src/messages.ts`, `src/bot.ts` (add `/syncschedule`)
- Test: `tests/camp-schedule.test.mts`

**Interfaces:**
- Produces: `syncCampSchedule(): Promise<number>` (returns slot count) and `getCampSlots(): Promise<{ time: string; activity: string }[]>` from `src/mc-store.ts`.
- `loadTodaySchedule()` keeps its exact existing signature and `ScheduleResult` shape.

- [ ] **Step 1: Write the failing test**

Create `tests/camp-schedule.test.mts`:

```typescript
process.env.BOT_TOKEN = "x";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "x@example.com";
process.env.GOOGLE_PRIVATE_KEY = "x";
process.env.SHEET_ID = "SHEET_MAIN";
process.env.GRID_SHEET_ID = "GRID";
process.env.MONGO_URI = "mongodb://stub";

import { check, report } from "./lib/assert.mts";
import { google } from "googleapis";

// Grid: two header rows, then time in column 8 and activity in column 9.
const GRID = [
  [], [],
  [...Array(8).fill(""), "08:00", "Підйом"],
  [...Array(8).fill(""), "09:00", "Сніданок"],
  [...Array(8).fill(""), "", ""],
];

let sheetsRequests = 0;
(google as unknown as { sheets: unknown }).sheets = () => ({
  spreadsheets: {
    values: {
      batchGet: async ({ ranges }: { ranges: string[] }) => {
        sheetsRequests++;
        return { data: { valueRanges: ranges.map(() => ({ values: GRID })) } };
      },
    },
  },
});

const data: Record<string, Record<string, unknown>[]> = { campSchedule: [] };
function makeStubDb() {
  return {
    collection(name: string) {
      if (!data[name]) data[name] = [];
      return {
        async deleteMany() { data[name] = []; },
        async insertMany(docs: Record<string, unknown>[]) { data[name].push(...docs); },
        async insertOne(doc: Record<string, unknown>) { data[name].push(doc); return { insertedId: "x" }; },
        find() { return { async toArray() { return data[name]; } }; },
        async findOne() { return data[name][0] ?? null; },
      };
    },
  };
}

const P = "/Users/serhii/projects/discovery-camp/src";
const mongo = await import(`${P}/mongo.ts`);
mongo.__setDbForTests(makeStubDb() as never);

const { syncCampSchedule } = await import(`${P}/mc-store.ts`);
const { loadTodaySchedule } = await import(`${P}/schedule.ts`);

console.log("\nBefore any sync:");
sheetsRequests = 0;
const empty = await loadTodaySchedule();
check("reports unavailable", empty.status, "unavailable");
check("no Sheets request", sheetsRequests, 0);

console.log("\n/syncschedule imports the grid:");
sheetsRequests = 0;
check("two slots imported", await syncCampSchedule(), 2);
check("the sync itself reads Sheets once", sheetsRequests, 1);

console.log("\nAfter sync:");
sheetsRequests = 0;
const result = await loadTodaySchedule();
check("no Sheets request", sheetsRequests, 0);
check("status ok", result.status, "ok");
if (result.status === "ok") {
  check("slot count", result.schedule.slots.length, 2);
  check("first activity", result.schedule.slots[0].activity, "Підйом");
  check("blank rows skipped", result.schedule.slots.map((s) => s.time), ["08:00", "09:00"]);
  check("day label present", result.schedule.dayLabel.length > 0, true);
}

report();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx tests/camp-schedule.test.mts`
Expected: FAIL — `syncCampSchedule is not a function`.

- [ ] **Step 3: Add the schedule store functions**

Append to `src/mc-store.ts`:

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

- [ ] **Step 4: Swap the fetch in `schedule.ts`**

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

Delete the now-unused `GRID_TAB` constant at the top of `schedule.ts` — it lives in `mc-store.ts` now. Everything else in the function, including the `isCurrent` highlighting, stays exactly as it is.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx tests/camp-schedule.test.mts`
Expected: PASS, all ten checks ok.

- [ ] **Step 6: Add the message and command**

In `src/messages.ts`, after `mcSynced`:

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

- [ ] **Step 7: Typecheck and run everything**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all suites pass.

- [ ] **Step 8: Commit**

```bash
git add src/schedule.ts src/mc-store.ts src/messages.ts src/bot.ts tests/camp-schedule.test.mts
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

Add `ensureIndexes` to the `./mc-store` import list.

- [ ] **Step 2: Verify index creation is idempotent**

Run: `npm test`
Expected: all suites pass — the stubs implement `createIndex` as a no-op, and re-running `/syncmc` must not error.

- [ ] **Step 3: Document the environment variables**

Add to `README.md` (or `.env.example` if that file exists) under the environment section:

```
MONGO_URI=mongodb+srv://...      # operational store; unset = Sheets only
MONGO_DB=discovery_camp          # optional, defaults to discovery_camp
```

- [ ] **Step 4: Update CLAUDE.md**

In the "Google Sheets schema" section, mark `EventRegs` as retired:

```markdown
- **`EventRegs`** — retired. Registrations live in MongoDB (`registrations` collection);
  this tab is no longer read or written. Left in place so pre-Mongo rows stay readable.
```

Add to "Key design notes":

```markdown
- **MongoDB is the operational store for masterclasses** (`src/mongo.ts`, `src/mc-store.ts`).
  The catalog, schedule and topics are imported from `MCSchedule` by `/syncmc`; the camp
  schedule from the badge grid by `/syncschedule`. Registrations live only in Mongo, where a
  unique partial index on `(date, slot, telegramId)` over `active: true` makes
  one-registration-per-slot a database guarantee — the read-count-append race the sheet
  version had is gone. The Mongo client is created once per lambda and never at module
  scope. `MONGO_URI` unset means Mongo is not configured; `/syncmc` will fail loudly.
```

Also remove the sentence in "Key design notes" that reads "**No database transactions**: concurrent registrations have a small race window — acceptable for camp scale." It is no longer true for registrations.

- [ ] **Step 5: Commit**

```bash
git add src/bot.ts CLAUDE.md README.md
git commit -m "docs: record the Mongo store and retire EventRegs

Indexes are created by /syncmc so they exist before the first registration
without any module-scope work. Drops the documented registration race,
which the unique partial index now prevents."
```

- [ ] **Step 6: Deploy and verify against production**

This is the step that matters — the plan is worthless if the cutover is wrong.

1. Set `MONGO_URI` and `MONGO_DB` in the Vercel project environment (Production).
2. Merge to `main` and deploy: `npx vercel --prod`
3. In Telegram, as an admin, run `/syncmc`. Expect a count matching the `MCSchedule` tab.
4. Run `/syncschedule`. Expect a count matching the badge grid.
5. Press `🎨 Майстер-класи` and confirm today's slots and capacities render.
6. Register for a masterclass, confirm the confirmation message, press `📋 Мої реєстрації`, then cancel.
7. Confirm in Mongo that `registrations` holds one document with `active: false`.

**Do all of this before the 13:00 Kyiv cron firing**, not after. If `/syncmc` has not been run, the catalog is empty and every masterclass button will silently vanish from the list — the failure is quiet, which is exactly why it needs checking by hand rather than waiting for a user report.

---

## Self-review notes

**Spec coverage.** Rollout steps 1–2 plus the camp schedule are covered: Mongo connection (Task 2), `/syncmc` and the catalog (Task 3), atomic registrations (Task 4), handler cutover including the reminder cron (Task 5), camp schedule and `/syncschedule` (Task 6), indexes and docs (Task 7). Spec sections deliberately **not** covered here, as agreed: visitors cache, `loadRoleContext`, role tabs, `/syncroles`, videos, `/syncvideo`, team rename and the `teams` collection.

**Known gap, accepted.** Attendee-name resolution (`👥 Учасники МК`) still reads Visitors from Sheets, since `registrations` stores only `telegramId`. That view is used by responsible persons a handful of times a day, so it stays on Sheets until the visitors cache lands in the post-camp phase. Verify it still works after Task 5 — it consumes `MCRegistration[]` and will need `asMCRegistrations`.

**Capacity is approximate under concurrency, then corrected.** `registerMongo` checks capacity before inserting and re-checks after, deactivating its own row if it lost. A true guarantee needs a transaction or a seat-counter document; the compensating check keeps the seat count exact without either, at the cost of a rare registrant seeing "full" after a brief success. The duplicate guarantee is exact regardless, because the unique index enforces it.
