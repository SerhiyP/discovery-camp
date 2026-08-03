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
