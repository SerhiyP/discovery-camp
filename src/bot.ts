import { Bot, Context, InlineKeyboard } from "grammy";
import { config, todayISO } from "./config";
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
  loadMasterclasses,
  loadMCRegistrations,
  loadMCSchedule,
  register,
  todaySlots,
  unregister,
} from "./masterclasses";
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
import { BTN, roleKeyboard } from "./keyboards";
import {
  addResponsible,
  findResponsibleByTelegramId,
  linkResponsibleRows,
  loadResponsible,
  removeResponsible,
  searchResponsibleByName,
} from "./responsible";

export const bot = new Bot(config.botToken);

const isSuperAdmin = (id?: number) => !!id && config.adminIds.includes(id);

async function keyboardForUser(telegramId: number): Promise<import("grammy").Keyboard | undefined> {
  const [{ leaders }, { responsible }] = await Promise.all([loadLeaders(), loadResponsible()]);
  const isLeader = findLeadersByTelegramId(leaders, telegramId).length > 0;
  const isResponsible = findResponsibleByTelegramId(responsible, telegramId).length > 0;
  if (isLeader || isResponsible) {
    return roleKeyboard({ leader: isLeader, responsible: isResponsible });
  }
  const { visitors } = await loadVisitors();
  if (findByTelegramId(visitors, telegramId)) return roleKeyboard();
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
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.leaderCheckedIn(leader.name, leader.team), kb ? { reply_markup: kb } : {});
});

bot.callbackQuery(/^link_resp:(\d+)$/, async (ctx) => {
  const rowIndex = Number(ctx.match[1]);
  const sheet = await loadResponsible();

  const row = sheet.responsible.find((r) => r.rowIndex === rowIndex);
  if (!row) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.respNotFound);
  }
  if (row.telegramId && row.telegramId !== String(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.rowTaken);
  }

  // Links every unlinked row with this name — one person may run several MCs.
  const linked = await linkResponsibleRows(sheet, row.name, ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();

  const mcs = await loadMasterclasses();
  const titles = linked
    .map((r) => mcs.find((m) => m.id === r.mcId)?.title ?? `МК ${r.mcId}`)
    .join(", ");
  const kb = await keyboardForUser(ctx.from.id);
  await ctx.reply(M.respCheckedIn(row.name, titles), kb ? { reply_markup: kb } : {});
});

// --- masterclasses ---

async function handleMasterclasses(ctx: Context) {
  const [mcs, schedule, regs] = await Promise.all([
    loadMasterclasses(),
    loadMCSchedule(),
    loadMCRegistrations(),
  ]);
  const slots = todaySlots(schedule);
  let sentAny = false;
  for (const s of slots) {
    const kb = new InlineKeyboard();
    const lines: string[] = [M.mcSlotTitle(s.slot), ""];
    let listed = 0;
    for (const id of s.mcIds) {
      const mc = mcs.find((m) => m.id === id);
      if (!mc) continue; // unknown ID in MCSchedule (or empty catalog) — skip silently
      const taken = activeRegs(regs, s.date, s.slot, mc.id);
      const mine = taken.some((r) => r.telegramId === String(ctx.from!.id));
      lines.push(M.mcLine(mc, taken.length, mine));
      kb.text(
        `${mine ? "❌" : "📝"} ${mc.title}`,
        `${mine ? "mcunreg" : "mcreg"}:${s.date}:${s.slot}:${mc.id}`,
      ).row();
      listed++;
    }
    if (listed === 0) continue;
    await ctx.reply(lines.join("\n"), { reply_markup: kb });
    sentAny = true;
  }
  if (!sentAny) return ctx.reply(M.noMasterclassesToday);
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
  return ctx.reply(M.scheduleUnavailable);
}

async function handleMyRegs(ctx: Context) {
  const [mcs, regs] = await Promise.all([loadMasterclasses(), loadMCRegistrations()]);
  const today = todayISO();
  const mine = regs.filter(
    (r) => r.telegramId === String(ctx.from!.id) && !r.cancelled && r.date >= today,
  );
  if (mine.length === 0) return ctx.reply(M.myRegsEmpty);
  const lines = [M.myRegsTitle, ""];
  for (const r of mine) {
    const mc = mcs.find((m) => m.id === r.mcId);
    if (mc) lines.push(`• ${r.date}, ${r.slot} — ${mc.title} (${mc.place})`);
  }
  return ctx.reply(lines.join("\n"));
}

bot.command("mc", handleMasterclasses);
bot.command("schedule", handleSchedule);
bot.command("myevents", handleMyRegs);

bot.callbackQuery(/^mcreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  const [mcs, { visitors }] = await Promise.all([loadMasterclasses(), loadVisitors()]);
  const mc = mcs.find((m) => m.id === mcId);
  const me = findByTelegramId(visitors, ctx.from.id);
  if (!mc) return ctx.answerCallbackQuery();
  if (!me) {
    await ctx.answerCallbackQuery();
    return ctx.reply(M.mustCheckInFirst);
  }
  const result = await register(date, slot, mcId, mc.capacity, ctx.from.id, me.name);
  await ctx.answerCallbackQuery(
    result === "ok"
      ? M.mcRegistered(mc.title, slot)
      : result === "full"
        ? M.mcFull
        : result === "already"
          ? M.mcAlready
          : M.mcSlotTaken,
  );
  if (result === "ok") await ctx.reply(M.mcRegistered(mc.title, slot));
  if (result === "slot_taken") await ctx.reply(M.mcSlotTaken);
});

bot.callbackQuery(/^mcunreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  const mcs = await loadMasterclasses();
  const mc = mcs.find((m) => m.id === mcId);
  const ok = await unregister(date, slot, mcId, ctx.from.id);
  await ctx.answerCallbackQuery();
  if (ok && mc) await ctx.reply(M.mcUnregistered(mc.title, slot));
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

bot.command("addresp", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.addRespUsage);
  const [mcId, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const mcs = await loadMasterclasses();
  const mc = mcs.find((m) => m.id === mcId);
  if (!mc) return ctx.reply(M.mcNotFoundAdmin(mcId));
  const result = await addResponsible(mcId, name);
  if (result === "duplicate") return ctx.reply(M.respDuplicate(name, mc.title));
  return ctx.reply(M.respAdded(name, mc.title));
});

bot.command("delresp", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply(M.delRespUsage);
  const [mcId, ...nameParts] = parts;
  const name = nameParts.join(" ");
  const ok = await removeResponsible(mcId, name);
  if (!ok) return ctx.reply(M.respNotFoundAdmin(name, mcId));
  const mcs = await loadMasterclasses();
  const title = mcs.find((m) => m.id === mcId)?.title ?? `МК ${mcId}`;
  return ctx.reply(M.respRemoved(name, title));
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

bot.hears(BTN.masterclasses, handleMasterclasses);
bot.hears(BTN.schedule, handleSchedule);
bot.hears(BTN.myRegs, handleMyRegs);
bot.hears(BTN.notifyTeam, (ctx) => ctx.reply(M.notifyTeamHint));
bot.hears(BTN.renameTeam, (ctx) => ctx.reply(M.renameTeamHint));

// --- name search (must be after commands) ---

bot.on("message:text", async (ctx) => {
  const [sheet, leaderSheet, respSheet] = await Promise.all([
    loadVisitors(),
    loadLeaders(),
    loadResponsible(),
  ]);

  const meVisitor = findByTelegramId(sheet.visitors, ctx.from.id);
  const meLeader = findLeadersByTelegramId(leaderSheet.leaders, ctx.from.id);

  // Always search unlinked leader/responsible entries — a visitor can also hold those roles.
  const leaderMatches = searchLeaderByName(leaderSheet.leaders, ctx.message.text);
  const respRows = searchResponsibleByName(respSheet.responsible, ctx.message.text);
  // One button per distinct person: the link_resp handler links all their rows at once.
  const respMatches = [...new Map(respRows.map((r) => [r.name.toLowerCase(), r])).values()];
  // Only search visitors if not yet linked as one.
  const visitorMatches = meVisitor ? [] : searchByName(sheet.visitors, ctx.message.text);

  if (visitorMatches.length === 0 && leaderMatches.length === 0 && respMatches.length === 0) {
    if (meLeader.length > 0) return ctx.reply(M.leaderAlreadyLinked(meLeader[0].name, meLeader[0].team));
    if (meVisitor) return ctx.reply(M.alreadyLinked(meVisitor.name));
    return ctx.reply(M.notFound);
  }

  const kb = new InlineKeyboard();

  if (visitorMatches.length === 1 && leaderMatches.length === 0 && respMatches.length === 0) {
    kb.text(visitorMatches[0].name, `link:${visitorMatches[0].rowIndex}`).row();
    return ctx.reply(M.confirmOne, { reply_markup: kb });
  }

  if (leaderMatches.length === 1 && visitorMatches.length === 0 && respMatches.length === 0) {
    const l = leaderMatches[0];
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
    return ctx.reply(M.confirmLeader(l.name, l.team), { reply_markup: kb });
  }

  if (respMatches.length === 1 && visitorMatches.length === 0 && leaderMatches.length === 0) {
    const r = respMatches[0];
    kb.text(`🎨 ${r.name}`, `link_resp:${r.rowIndex}`).row();
    return ctx.reply(M.confirmResp(r.name), { reply_markup: kb });
  }

  for (const v of visitorMatches) kb.text(v.name, `link:${v.rowIndex}`).row();
  for (const l of leaderMatches)
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
  for (const r of respMatches) kb.text(`🎨 ${r.name}`, `link_resp:${r.rowIndex}`).row();

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
