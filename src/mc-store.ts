import { Masterclass, SlotSchedule, loadMCTabRows, loadMasterclasses, loadMCSchedule, loadMCTopics, MCRegistration, RegisterResult } from "./masterclasses";
import { COLLECTIONS, db } from "./mongo";
import { nowStamp, config } from "./config";
import { getRowsFromSpreadsheet } from "./sheets";

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

  await rebuildSeatCounters();

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

export interface MongoRegistration {
  date: string;
  slot: string;
  mcId: string;
  telegramId: string;
  active: boolean;
  registeredAt: string;
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

const CAMP_SCHEDULE_ID = "grid";

/** Imports the badge-grid schedule into Mongo. The grid applies no per-date filtering —
 *  the same slot list serves every camp day — so it is a single document. */
export async function syncCampSchedule(): Promise<number> {
  if (!config.gridSheetId) return 0;
  const rows = await getRowsFromSpreadsheet(config.gridSheetId, "3.Розклад табору 2026");
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

export async function getRegistrations(): Promise<MongoRegistration[]> {
  const docs = await (await db()).collection(COLLECTIONS.registrations).find({}).toArray();
  return docs.map((d) => ({
    date: String(d.date ?? ""),
    slot: String(d.slot ?? ""),
    mcId: String(d.mcId ?? ""),
    telegramId: String(d.telegramId ?? ""),
    active: d.active === true,
    registeredAt: String(d.registeredAt ?? ""),
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
    registeredAt: r.registeredAt,
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
