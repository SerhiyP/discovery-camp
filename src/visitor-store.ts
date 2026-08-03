import { Visitor, loadVisitors } from "./checkin";
import { COLLECTIONS, db } from "./mongo";
import { nowStamp } from "./config";

// Mirror of the Visitors tab for telegramId lookups. Both doctorStatus and
// paymentStatus are mirrored (2026-08-03 incident: check-in linking moved onto Mongo
// — see linkAndCheckInMongo — so the gate needs both fields wherever the read
// happens). paymentStatus is part of the stable IMPORTRANGE'd block (moves correctly
// with the name), so it's trustworthy as synced. doctorStatus is written by
// handleDoctorScan via a Telegram-ID lookup — same mechanism that was corrupted by
// the row-shift incident — so historical values carry some residual risk; accepted
// knowingly for speed on 2026-08-03.
interface VisitorDoc {
  _id: number; // sheet rowIndex, 0-based incl. header — what updateCell addresses
  name: string;
  age: string;
  team: string;
  room: string;
  specialNeeds: string;
  telegramId: string;
  checkedIn: string;
  doctorStatus: string;
  paymentStatus: string;
}

function toVisitor(d: Partial<VisitorDoc>): Visitor {
  return {
    rowIndex: Number(d._id ?? -1),
    name: String(d.name ?? ""),
    age: String(d.age ?? ""),
    paymentStatus: String(d.paymentStatus ?? ""),
    doctorStatus: String(d.doctorStatus ?? ""),
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
    doctorStatus: v.doctorStatus,
    paymentStatus: v.paymentStatus,
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
        doctorStatus: v.doctorStatus,
        paymentStatus: v.paymentStatus,
      },
    },
    { upsert: true },
  );
}

/** One-off live re-check of payment status when the Mongo copy says "not paid yet" —
 *  nothing writes paymentStatus live (the financist edits the sheet directly, and it
 *  only reaches Mongo via /syncvisitors), so this covers the gap the same way
 *  findVisitorByTelegramIdMongo covers a telegramId miss: one live Sheets read,
 *  backfilled into Mongo so the next check is cache-only again. doctorStatus is NOT
 *  refreshed here — Mongo is already authoritative for it via markDoctorExamMongo,
 *  and the sheet's own copy is frozen since that scan stopped writing there. */
export async function refreshPaymentStatusMongo(rowIndex: number): Promise<string> {
  const { visitors } = await loadVisitors();
  const paymentStatus = visitors.find((v) => v.rowIndex === rowIndex)?.paymentStatus ?? "";
  if (paymentStatus) {
    const col = (await db()).collection(COLLECTIONS.visitors);
    await col.updateOne({ _id: rowIndex as never }, { $set: { paymentStatus } });
  }
  return paymentStatus;
}

/** Marks the doctor exam done directly in the mirror — the sheet is no longer touched
 *  for this (2026-08-03: doctor status now lives in Mongo, read straight off the
 *  visitor returned by findVisitorByTelegramIdMongo). */
export async function markDoctorExamMongo(rowIndex: number): Promise<void> {
  const col = (await db()).collection(COLLECTIONS.visitors);
  await col.updateOne({ _id: rowIndex as never }, { $set: { doctorStatus: nowStamp() } });
}

/**
 * 2026-08-03 incident: links a Telegram account directly in the Mongo mirror instead
 * of the sheet, so a mass re-check-in doesn't hit the Sheets write quota (updateCell
 * calls have no retry, unlike reads). Mirrors checkin.ts's linkAndCheckIn — same
 * "already linked to someone else" guard — but Mongo is the write target, not a
 * mirror of one. The sheet's own Checked in/Telegram ID columns are left blank.
 */
export async function linkAndCheckInMongo(
  rowIndex: number,
  telegramId: number,
): Promise<{ ok: boolean; visitor?: Visitor }> {
  const col = (await db()).collection(COLLECTIONS.visitors);
  const doc = await col.findOne({ _id: rowIndex as never });
  if (!doc) return { ok: false };

  const visitor = toVisitor(doc as never);
  if (visitor.telegramId && visitor.telegramId !== String(telegramId)) {
    return { ok: false, visitor };
  }

  const checkedIn = visitor.checkedIn || nowStamp();
  await col.updateOne(
    { _id: rowIndex as never },
    { $set: { telegramId: String(telegramId), checkedIn } },
  );
  return { ok: true, visitor: { ...visitor, telegramId: String(telegramId), checkedIn } };
}
