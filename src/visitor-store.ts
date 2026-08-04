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

/** Mongo lookup by Telegram ID with no Sheets fallback. Use this wherever a miss is the
 *  routine case (a mistyped ID in /fixcheckin) or the caller must not spend a read from
 *  the camp's shared 60-reads-per-minute Sheets quota. */
export async function findVisitorByTelegramIdMongoOnly(
  telegramId: number,
): Promise<Visitor | undefined> {
  const col = (await db()).collection(COLLECTIONS.visitors);
  const doc = await col.findOne({ telegramId: String(telegramId) });
  return doc ? toVisitor(doc as never) : undefined;
}

/**
 * Mongo lookup by Telegram ID, with one Sheets read as a fallback on a miss.
 *
 * The fallback only back-fills a row the mirror does not have **at all**. If the mirror
 * does hold that row and simply does not point at this account, Mongo wins and the answer
 * is "no row" — a deliberate release must beat a stale sheet cell. Since 2026-08-03
 * nothing writes the sheet's `Checked in` / `Telegram ID` columns, so an ID sitting there
 * is at best a pre-migration leftover, while the mirror's state is what /fixcheckin's
 * release (and every check-in since the migration) actually wrote. Trusting the sheet here
 * silently resurrects a released link: the released account presses /start as its DM tells
 * it to, the stale cell rewrites the doc through upsertVisitorMongo, telegramId/checkedIn
 * come back and doctorStatus/paymentStatus are overwritten with the sheet's frozen values —
 * with no error anywhere and the right person still locked out.
 *
 * The mirror's row is the release marker, so no extra field is needed (and a `releasedAt`
 * flag would be wiped by syncVisitorsFromSheets' replace anyway).
 */
export async function findVisitorByTelegramIdMongo(
  telegramId: number,
): Promise<Visitor | undefined> {
  const mirrored = await findVisitorByTelegramIdMongoOnly(telegramId);
  if (mirrored) return mirrored;

  const { visitors } = await loadVisitors();
  const v = visitors.find((x) => x.telegramId === String(telegramId));
  if (!v) return undefined;

  const col = (await db()).collection(COLLECTIONS.visitors);
  const mirroredRow = await col.findOne({ _id: v.rowIndex as never }, { projection: { _id: 1 } });
  if (mirroredRow) return undefined; // mirror knows this row and disagrees — it wins.

  await upsertVisitorMongo(v).catch(() => {});
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

/** Single-row read by sheet rowIndex — what the /fixcheckin confirm screen needs. Avoids
 *  pulling the whole mirror through getVisitorsMongo just to re-render one row. */
export async function findVisitorByRowMongo(rowIndex: number): Promise<Visitor | undefined> {
  const col = (await db()).collection(COLLECTIONS.visitors);
  const doc = await col.findOne({ _id: rowIndex as never });
  return doc ? toVisitor(doc as never) : undefined;
}

/**
 * Releases a wrongly-claimed row so the right person can check in — the exact inverse of
 * linkAndCheckInMongo. Mongo only: the sheet's Checked in / Telegram ID columns have not
 * been written since 2026-08-03 and stay untouched here too.
 *
 * doctorStatus is deliberately kept. The motivating case is a swap — two people who picked
 * each other's rows — where both really were examined by the doctor, so both rows carry a
 * mark a real exam produced. See docs/superpowers/specs/2026-08-04-fix-checkin-design.md.
 *
 * Returns the pre-release visitor, because the caller needs the old telegramId to notify
 * that account. The clear is a single guarded findOneAndUpdate rather than read-then-write,
 * so two admins racing on the same row produce exactly one release and one notification.
 *
 * It is a compare-and-swap, not just an "is it claimed" check: `expectedTelegramId` is the
 * holder the admin saw on the confirm screen, and a row that changed hands in the meantime
 * does not match. Without it, a confirm screen left open while a second admin released the
 * row and the *right* person re-claimed it would release that legitimate check-in — and the
 * right person is standing at the desk at exactly that moment, which is the whole point of
 * the feature. A no-match returns undefined, which the caller reports as "already free".
 */
export async function releaseCheckInMongo(
  rowIndex: number,
  expectedTelegramId: string,
): Promise<Visitor | undefined> {
  // A free row stores telegramId: "", so an empty expectation would match one and "release"
  // it — returning a visitor whose telegramId is empty for the caller to then DM.
  if (!expectedTelegramId) return undefined;
  const col = (await db()).collection(COLLECTIONS.visitors);
  const before = await col.findOneAndUpdate(
    { _id: rowIndex as never, telegramId: expectedTelegramId },
    { $set: { telegramId: "", checkedIn: "" } },
    { returnDocument: "before" },
  );
  return before ? toVisitor(before as never) : undefined;
}
