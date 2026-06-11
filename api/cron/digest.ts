import type { VercelRequest, VercelResponse } from "@vercel/node";
import { bot } from "../../src/bot";
import { loadVisitors } from "../../src/checkin";
import { loadEvents, todayEvents } from "../../src/events";
import { M } from "../../src/messages";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const [events, { visitors }] = await Promise.all([loadEvents(), loadVisitors()]);
  const today = todayEvents(events);
  if (today.length === 0) return res.json({ sent: 0, reason: "no events today" });

  const lines = [M.morningDigest, ""];
  for (const e of today) lines.push(`• ${e.time} — ${e.title}`);
  lines.push("", "/events — зареєструватися");
  const text = lines.join("\n");

  const ids = [...new Set(visitors.filter((v) => v.telegramId).map((v) => v.telegramId))];
  let sent = 0;
  for (const id of ids) {
    try {
      await bot.api.sendMessage(id, text);
      sent++;
    } catch {
      // user blocked the bot etc.
    }
  }
  return res.json({ sent, total: ids.length });
}
