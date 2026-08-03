import type { VercelRequest, VercelResponse } from "@vercel/node";
import { InlineKeyboard } from "grammy";
import { bot } from "../../src/bot";
import { M } from "../../src/messages";
import { buildSlotButtons, hasActiveRegistrationForSlot, todaySlots, topicLines } from "../../src/masterclasses";
import {
  asMCRegistrations,
  getMasterclasses,
  getMCSchedule,
  getMCTopics,
  getRegistrations,
} from "../../src/mc-store";
import { getVisitorsMongo } from "../../src/visitor-store";

// Reminds checked-in visitors who haven't registered for an upcoming masterclass
// slot yet. Triggered by two Vercel Cron entries (see vercel.json), one per slot,
// each passing which slot start time ("12:00", "14:00", ...) to remind about via
// the `before` query param — matched against the slot's start time so it keeps
// working if the exact end time in MCSchedule shifts day to day.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const before = String(req.query.before ?? "");
  if (!before) return res.status(400).json({ error: "missing 'before' query param" });

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

  let sent = 0;
  let total = 0;
  for (const s of slots) {
    const buttons = buildSlotButtons(s, mcs, regs);
    if (buttons.length === 0) continue;
    const kb = new InlineKeyboard();
    for (const b of buttons) kb.text(b.label, b.cbData).row();

    const tLines = topicLines(s.mcIds, mcs, topics, s.date);
    const reminderText = tLines.length
      ? [M.mcReminder(s.slot), "", ...tLines].join("\n")
      : M.mcReminder(s.slot);

    const recipients = [
      ...new Set(
        visitors
          .filter((v) => {
            const checkedInStr = (v.checkedIn ?? "").trim().toLowerCase();
            const isCheckedIn = checkedInStr && !["false", "no", "ні", "0"].includes(checkedInStr);
            return isCheckedIn && v.telegramId;
          })
          .filter((v) => !hasActiveRegistrationForSlot(regs, s.date, s.slot, v.telegramId))
          .map((v) => v.telegramId),
      ),
    ];
    total += recipients.length;

    // Send messages in chunks of 15 to avoid Telegram API rate limits (max 30/s)
    const CHUNK_SIZE = 15;
    for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
      const chunk = recipients.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (id) => {
          try {
            await bot.api.sendMessage(id, reminderText, { reply_markup: kb });
            sent++;
          } catch {
            // user blocked the bot, invalid ID, etc.
          }
        })
      );
      if (i + CHUNK_SIZE < recipients.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000)); // sleep 1s between chunks
      }
    }
  }
  return res.json({ sent, total });
}
