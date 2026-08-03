import { Masterclass, SlotSchedule, loadMCTabRows, loadMasterclasses, loadMCSchedule, loadMCTopics, MCRegistration, RegisterResult } from "./masterclasses";
import { COLLECTIONS, db } from "./mongo";
import { nowStamp } from "./config";

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
  // seat count exact without a transaction. The sort is load-bearing: find() without a
  // sort has no guaranteed order, so two racers could each compute a different loser set
  // (both roll back, or neither does). _id is insertion-ordered, so sorting by it makes
  // every racer agree on who overflowed.
  if (capacity > 0) {
    const taken = await col.countDocuments({ date, slot, mcId, active: true });
    if (taken > capacity) {
      const all = await col
        .find({ date, slot, mcId, active: true })
        .sort({ _id: 1 })
        .toArray();
      const overflow = all.slice(capacity).some((d) => String(d.telegramId) === id);
      if (overflow) {
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
