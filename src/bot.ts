import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config";
import {
  findByTelegramId,
  linkAndCheckIn,
  loadVisitors,
  renameTeamVideo,
  renameVisitorTeams,
  searchByName,
  updateTeamVideo,
  videoForTeam,
} from "./checkin";
import {
  activeRegs,
  loadEvents,
  loadRegistrations,
  register,
  todayEvents,
  unregister,
  upcomingEvents,
} from "./events";
import { M } from "./messages";
import { addAdmin, isAdmin, loadAdmins, removeAdmin } from "./admins";
import {
  addLeader,
  findLeadersByTelegramId,
  loadLeaders,
  removeLeader,
  renameLeaderTeams,
  searchLeaderByName,
  setLeaderTelegramId,
} from "./leaders";
import { initCommandMenus, setCommandsForUser } from "./commands";

export const bot = new Bot(config.botToken);

const isSuperAdmin = (id?: number) => !!id && config.adminIds.includes(id);

// --- check-in ---

bot.command("start", async (ctx) => {
  const { visitors } = await loadVisitors();
  const me = findByTelegramId(visitors, ctx.from!.id);
  if (me) return ctx.reply(M.alreadyLinked(me.name));
  return ctx.reply(M.welcome);
});

bot.command("myid", async (ctx) => {
  await ctx.reply(M.yourId(ctx.from!.id), { parse_mode: "HTML" });
});

bot.command("leader", async (ctx) => {
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length > 0) {
    return ctx.reply(M.leaderAlreadyLinked(mine[0].name, mine[0].team));
  }
  return ctx.reply(M.leaderPrompt);
});

bot.callbackQuery(/^link:(\d+)$/, async (ctx) => {
  const rowIndex = Number(ctx.match[1]);
  const sheet = await loadVisitors();

  const already = findByTelegramId(sheet.visitors, ctx.from.id);
  if (already) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.alreadyLinked(already.name));
  }

  const { ok, visitor } = await linkAndCheckIn(sheet, rowIndex, ctx.from.id);
  await ctx.answerCallbackQuery();
  if (!ok || !visitor) return ctx.editMessageText(M.rowTaken);

  await ctx.editMessageText(M.checkedIn(visitor.name));
  const fileId = await videoForTeam(visitor.team);
  if (fileId) {
    await ctx.replyWithVideo(fileId, { caption: M.videoCaption });
  }
});

bot.callbackQuery(/^link_leader:(\d+)$/, async (ctx) => {
  const rowIndex = Number(ctx.match[1]);
  const leaderSheet = await loadLeaders();

  const alreadyLinked = findLeadersByTelegramId(leaderSheet.leaders, ctx.from.id);
  if (alreadyLinked.length > 0) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.leaderAlreadyLinked(alreadyLinked[0].name, alreadyLinked[0].team));
  }

  const leader = leaderSheet.leaders.find((l) => l.rowIndex === rowIndex);
  if (!leader) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.leaderNotFound);
  }
  if (leader.telegramId && leader.telegramId !== String(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.rowTaken);
  }

  await setLeaderTelegramId(leaderSheet, rowIndex, ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(M.leaderCheckedIn(leader.name, leader.team));

  const { admins } = await loadAdmins();
  const role = isSuperAdmin(ctx.from.id)
    ? "superadmin"
    : isAdmin(ctx.from.id, admins)
    ? "admin"
    : "leader";
  await setCommandsForUser(bot, ctx.from.id, role);
});

// --- events ---

function eventLine(e: { time: string; title: string }): string {
  return `${e.time} — ${e.title}`;
}

bot.command("events", async (ctx) => {
  const [events, regs] = await Promise.all([loadEvents(), loadRegistrations()]);
  const today = todayEvents(events);
  if (today.length === 0) return ctx.reply(M.noEventsToday);

  const kb = new InlineKeyboard();
  const lines: string[] = [M.eventsToday, ""];
  for (const e of today) {
    const taken = activeRegs(regs, e.id);
    const mine = taken.some((r) => r.telegramId === String(ctx.from!.id));
    const free = e.capacity > 0 ? ` (${M.spotsLeft(Math.max(0, e.capacity - taken.length))})` : "";
    lines.push(`• ${eventLine(e)}${free}${mine ? " ✅" : ""}`);
    kb.text(
      mine ? `❌ ${e.title}` : `📝 ${e.title}`,
      mine ? `unreg:${e.id}` : `reg:${e.id}`,
    ).row();
  }
  return ctx.reply(lines.join("\n"), { reply_markup: kb });
});

bot.command("schedule", async (ctx) => {
  const events = upcomingEvents(await loadEvents());
  if (events.length === 0) return ctx.reply(M.noEventsToday);
  const byDate = new Map<string, string[]>();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date)!.push(`  • ${eventLine(e)}`);
  }
  const lines = [M.scheduleTitle, ""];
  for (const [date, items] of byDate) lines.push(date, ...items, "");
  return ctx.reply(lines.join("\n"));
});

bot.command("myevents", async (ctx) => {
  const [events, regs] = await Promise.all([loadEvents(), loadRegistrations()]);
  const mine = regs.filter(
    (r) => r.telegramId === String(ctx.from!.id) && !r.cancelled,
  );
  if (mine.length === 0) return ctx.reply(M.myEventsEmpty);
  const lines = [M.myEventsTitle, ""];
  for (const r of mine) {
    const e = events.find((ev) => ev.id === r.eventId);
    if (e) lines.push(`• ${e.date} ${eventLine(e)}`);
  }
  return ctx.reply(lines.join("\n"));
});

bot.callbackQuery(/^reg:(.+)$/, async (ctx) => {
  const eventId = ctx.match[1];
  const [events, { visitors }] = await Promise.all([loadEvents(), loadVisitors()]);
  const event = events.find((e) => e.id === eventId);
  const me = findByTelegramId(visitors, ctx.from.id);
  if (!event) return ctx.answerCallbackQuery();
  if (!me) {
    await ctx.answerCallbackQuery();
    return ctx.reply(M.mustCheckInFirst);
  }
  const result = await register(eventId, event.capacity, ctx.from.id, me.name);
  await ctx.answerCallbackQuery(
    result === "ok"
      ? M.registered(event.title)
      : result === "full"
        ? M.eventFull
        : M.alreadyRegistered,
  );
  if (result === "ok") await ctx.reply(M.registered(event.title));
});

bot.callbackQuery(/^unreg:(.+)$/, async (ctx) => {
  const eventId = ctx.match[1];
  const events = await loadEvents();
  const event = events.find((e) => e.id === eventId);
  const ok = await unregister(eventId, ctx.from.id);
  await ctx.answerCallbackQuery();
  if (ok && event) await ctx.reply(M.unregistered(event.title));
});

// --- admin helpers ---

// Admin sends/forwards a video to the bot -> bot replies with its file_id
// (put it into the Videos tab or DEFAULT_VIDEO_FILE_ID).
bot.on("message:video", async (ctx) => {
  if (!isSuperAdmin(ctx.from?.id)) return;
  await ctx.reply(`file_id:\n<code>${ctx.message.video.file_id}</code>`, {
    parse_mode: "HTML",
  });
});

bot.command("broadcast", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return;
  const text = ctx.match;
  if (!text) return ctx.reply("Usage: /broadcast <text>");
  const { visitors } = await loadVisitors();
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
  return ctx.reply(`Sent to ${sent}/${ids.length}`);
});

// --- name search (must be after commands) ---

bot.on("message:text", async (ctx) => {
  const [sheet, leaderSheet] = await Promise.all([loadVisitors(), loadLeaders()]);

  const meVisitor = findByTelegramId(sheet.visitors, ctx.from.id);
  if (meVisitor) return ctx.reply(M.alreadyLinked(meVisitor.name));

  const meLeader = findLeadersByTelegramId(leaderSheet.leaders, ctx.from.id);
  if (meLeader.length > 0) {
    return ctx.reply(M.leaderAlreadyLinked(meLeader[0].name, meLeader[0].team));
  }

  const visitorMatches = searchByName(sheet.visitors, ctx.message.text);
  const leaderMatches = searchLeaderByName(leaderSheet.leaders, ctx.message.text);

  if (visitorMatches.length === 0 && leaderMatches.length === 0) {
    return ctx.reply(M.notFound);
  }

  const kb = new InlineKeyboard();

  if (visitorMatches.length === 1 && leaderMatches.length === 0) {
    kb.text(visitorMatches[0].name, `link:${visitorMatches[0].rowIndex}`).row();
    return ctx.reply(M.confirmOne, { reply_markup: kb });
  }

  if (leaderMatches.length === 1 && visitorMatches.length === 0) {
    const l = leaderMatches[0];
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
    return ctx.reply(M.confirmLeader(l.name, l.team), { reply_markup: kb });
  }

  for (const v of visitorMatches) kb.text(v.name, `link:${v.rowIndex}`).row();
  for (const l of leaderMatches)
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();

  return ctx.reply(M.chooseYourself, { reply_markup: kb });
});
