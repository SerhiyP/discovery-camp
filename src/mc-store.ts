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
