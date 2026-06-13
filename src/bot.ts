import { Bot, Context, InlineKeyboard } from "grammy";
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
import { loadTodaySchedule } from "./schedule";
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
import { BTN, leaderKeyboard, visitorKeyboard } from "./keyboards";

export const bot = new Bot(config.botToken);

const isSuperAdmin = (id?: number) => !!id && config.adminIds.includes(id);

async function keyboardForUser(telegramId: number): Promise<import("grammy").Keyboard | undefined> {
  const { leaders } = await loadLeaders();
  const isLeader = findLeadersByTelegramId(leaders, telegramId).length > 0;
  if (isLeader) return leaderKeyboard();
  const { visitors } = await loadVisitors();
  if (findByTelegramId(visitors, telegramId)) return visitorKeyboard();
  return undefined;
}

// --- check-in ---

bot.command("start", async (ctx) => {
  const { visitors } = await loadVisitors();
  const me = findByTelegramId(visitors, ctx.from!.id);
  if (me) {
    const kb = await keyboardForUser(ctx.from!.id);
    return ctx.reply(M.alreadyLinked(me.name), kb ? { reply_markup: kb } : {});
  }
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

  await ctx.deleteMessage();
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.checkedIn(visitor.name, visitor.room || undefined), kb ? { reply_markup: kb } : {});
  const video = await videoForTeam(visitor.team);
  if (video) {
    if (video.isVideoNote) {
      await ctx.replyWithVideoNote(video.fileId);
    } else {
      await ctx.replyWithVideo(video.fileId, { caption: M.videoCaption });
    }
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
  await ctx.deleteMessage();

  const { admins } = await loadAdmins();
  const role = isSuperAdmin(ctx.from.id)
    ? "superadmin"
    : isAdmin(ctx.from.id, admins)
    ? "admin"
    : "leader";
  await setCommandsForUser(bot, ctx.from.id, role);
  await ctx.reply(M.leaderCheckedIn(leader.name, leader.team), { reply_markup: leaderKeyboard() });
});

// --- events ---

function eventLine(e: { time: string; title: string }): string {
  return `${e.time} — ${e.title}`;
}

async function handleEvents(ctx: Context) {
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
}

async function handleSchedule(ctx: Context) {
  const result = await loadTodaySchedule();
  if (result.status === "finished") return ctx.reply(M.scheduleCampFinished);
  if (result.status === "ok") {
    const { schedule } = result;
    const lines: string[] = [];
    if (!schedule.isToday) lines.push(M.scheduleNotStarted, "");
    lines.push(M.scheduleGridTitle(schedule.dayLabel), "");
    lines.push(...schedule.slots.map((s) => M.scheduleGridLine(s)));
    return ctx.reply(lines.join("\n"));
  }

  // status === "unavailable" → fall back to the events list
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
}

async function handleMyEvents(ctx: Context) {
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
}

bot.command("events", handleEvents);
bot.command("schedule", handleSchedule);
bot.command("myevents", handleMyEvents);

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
// Leaders can send a video to update their team's video.
bot.on(["message:video", "message:video_note"], async (ctx) => {
  const isVideoNote = !!ctx.message.video_note;
  const fileId = ctx.message.video?.file_id ?? ctx.message.video_note!.file_id;

  let sentFileId = false;

  if (isSuperAdmin(ctx.from?.id)) {
    await ctx.reply(`file_id:\n<code>${fileId}</code>`, { parse_mode: "HTML" });
    sentFileId = true;
  } else {
    const { admins } = await loadAdmins();
    if (isAdmin(ctx.from?.id, admins)) {
      await ctx.reply(`file_id:\n<code>${fileId}</code>`, { parse_mode: "HTML" });
      sentFileId = true;
    }
  }

  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length === 0) return;

  const myTeams = [...new Set(mine.map((l) => l.team))];

  if (myTeams.length === 1) {
    const ok = await updateTeamVideo(myTeams[0], fileId, isVideoNote);
    return ctx.reply(ok ? M.videoUpdated(myTeams[0]) : `Команду «${myTeams[0]}» не знайдено у таблиці Videos (перевірте колонку ID).`);
  }

  const caption = (ctx.message.caption ?? "").trim();
  const matched = myTeams.find((t) => t.toLowerCase() === caption.toLowerCase());
  if (matched) {
    const ok = await updateTeamVideo(matched, fileId, isVideoNote);
    return ctx.reply(ok ? M.videoUpdated(matched) : `Команду «${matched}» не знайдено у таблиці Videos (перевірте колонку ID).`);
  }

  return ctx.reply(M.videoMultiTeamHint(myTeams.join(", ")));
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

// --- admin commands ---

bot.command("addleader", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.addLeaderUsage);
  const [team, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const result = await addLeader(team, name);
  if (result === "full") return ctx.reply(M.leaderAddedFull(team));
  if (result === "duplicate") return ctx.reply(M.leaderAddedDuplicate(name, team));
  return ctx.reply(M.leaderAdded(name, team));
});

bot.command("removeleader", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.removeLeaderUsage);
  const [team, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const ok = await removeLeader(team, name);
  if (!ok) return ctx.reply(M.leaderNotFoundAdmin(name, team));
  return ctx.reply(M.leaderRemoved(name, team));
});

bot.command("listleaders", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const { leaders } = await loadLeaders();
  if (leaders.length === 0) return ctx.reply(M.noLeaders);
  const lines = [M.leadersListTitle, ""];
  for (const l of leaders) lines.push(M.leaderListLine(l.team, l.name, !!l.telegramId));
  return ctx.reply(lines.join("\n"));
});

// --- superadmin commands ---

bot.command("addadmin", async (ctx) => {
  if (!isSuperAdmin(ctx.from?.id)) return ctx.reply(M.notSuperAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.addAdminUsage);
  const [telegramId, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const result = await addAdmin(telegramId, name);
  if (result === "duplicate") return ctx.reply(M.adminAddedDuplicate(telegramId));
  await ctx.reply(M.adminAdded(name, telegramId));
  const numId = Number(telegramId);
  if (numId) await setCommandsForUser(bot, numId, "admin");
});

bot.command("removeadmin", async (ctx) => {
  if (!isSuperAdmin(ctx.from?.id)) return ctx.reply(M.notSuperAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (!parts[0]) return ctx.reply(M.removeAdminUsage);
  const telegramId = parts[0];
  const ok = await removeAdmin(telegramId);
  if (!ok) return ctx.reply(M.adminNotFound(telegramId));
  await ctx.reply(M.adminRemoved(telegramId));
  const numId = Number(telegramId);
  if (numId) {
    const { leaders } = await loadLeaders();
    const stillLeader = findLeadersByTelegramId(leaders, numId).length > 0;
    await setCommandsForUser(bot, numId, stillLeader ? "leader" : "user");
  }
});

bot.command("listadmins", async (ctx) => {
  if (!isSuperAdmin(ctx.from?.id)) return ctx.reply(M.notSuperAdmin);
  const { admins } = await loadAdmins();
  if (admins.length === 0) return ctx.reply(M.noAdmins);
  const lines = [M.adminsListTitle, ""];
  for (const a of admins) lines.push(M.adminListLine(a.name, a.telegramId));
  return ctx.reply(lines.join("\n"));
});

// --- leader commands ---

bot.command("notifyteam", async (ctx) => {
  const text = ctx.match.trim();
  if (!text) return ctx.reply(M.notifyTeamNoText);
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length === 0) return ctx.reply(M.notLeader);
  const myTeams = [...new Set(mine.map((l) => l.team))];
  const { visitors } = await loadVisitors();
  const members = visitors.filter(
    (v) => v.telegramId && myTeams.some((t) => t.toLowerCase() === v.team.toLowerCase()),
  );
  if (members.length === 0) return ctx.reply(M.notifyTeamEmpty);
  const ids = [...new Set(members.map((v) => v.telegramId))];
  let sent = 0;
  for (const id of ids) {
    try {
      await bot.api.sendMessage(id, text);
      sent++;
    } catch {
      // user blocked the bot or never started it
    }
  }
  return ctx.reply(M.notifyTeamSent(sent, myTeams.join(", ")));
});

bot.command("renameteam", async (ctx) => {
  const newName = ctx.match.trim();
  if (!newName) return ctx.reply(M.renameTeamNoText);
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length === 0) return ctx.reply(M.notLeader);
  const myTeams = [...new Set(mine.map((l) => l.team))];
  if (myTeams.length === 1) {
    const oldTeam = myTeams[0];
    const [visitorsCount] = await Promise.all([
      renameVisitorTeams(oldTeam, newName),
      renameLeaderTeams(oldTeam, newName),
      renameTeamVideo(oldTeam, newName),
    ]);
    return ctx.reply(M.renameTeamDone(oldTeam, newName, visitorsCount));
  }
  const kb = new InlineKeyboard();
  for (let i = 0; i < myTeams.length; i++) kb.text(myTeams[i], `rt:${i}`).row();
  return ctx.reply(M.chooseTeamToRename(newName), { reply_markup: kb });
});

bot.callbackQuery(/^rt:(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  const msgText = ctx.callbackQuery.message?.text ?? "";
  const newNameMatch = msgText.match(/«(.+)»/);
  if (!newNameMatch) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.renameTeamNoText);
  }
  const newName = newNameMatch[1];
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from.id);
  const myTeams = [...new Set(mine.map((l) => l.team))];
  const oldTeam = myTeams[idx];
  if (!oldTeam) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.notLeader);
  }
  await ctx.answerCallbackQuery();
  const [visitorsCount] = await Promise.all([
    renameVisitorTeams(oldTeam, newName),
    renameLeaderTeams(oldTeam, newName),
    renameTeamVideo(oldTeam, newName),
  ]);
  return ctx.editMessageText(M.renameTeamDone(oldTeam, newName, visitorsCount));
});

// --- keyboard button handlers (must be before message:text catch-all) ---

bot.hears(BTN.events, handleEvents);
bot.hears(BTN.schedule, handleSchedule);
bot.hears(BTN.myEvents, handleMyEvents);
bot.hears(BTN.notifyTeam, (ctx) => ctx.reply(M.notifyTeamHint));
bot.hears(BTN.renameTeam, (ctx) => ctx.reply(M.renameTeamHint));

// --- name search (must be after commands) ---

bot.on("message:text", async (ctx) => {
  const [sheet, leaderSheet] = await Promise.all([loadVisitors(), loadLeaders()]);

  const meVisitor = findByTelegramId(sheet.visitors, ctx.from.id);
  const meLeader = findLeadersByTelegramId(leaderSheet.leaders, ctx.from.id);

  // Always search for unlinked leader entries — a visitor can also be a leader.
  const leaderMatches = searchLeaderByName(leaderSheet.leaders, ctx.message.text);
  // Only search visitors if not yet linked as one.
  const visitorMatches = meVisitor ? [] : searchByName(sheet.visitors, ctx.message.text);

  if (visitorMatches.length === 0 && leaderMatches.length === 0) {
    if (meLeader.length > 0) return ctx.reply(M.leaderAlreadyLinked(meLeader[0].name, meLeader[0].team));
    if (meVisitor) return ctx.reply(M.alreadyLinked(meVisitor.name));
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

// Set scoped command menus for all known privileged users on cold start.
(async () => {
  try {
    const [{ admins }, { leaders }] = await Promise.all([loadAdmins(), loadLeaders()]);
    await initCommandMenus(bot, admins, leaders);
  } catch {
    // Non-fatal: menus fall back to defaults if sheets are temporarily unavailable.
  }
})();
