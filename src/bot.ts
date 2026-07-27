import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { MessageEntity } from "grammy/types";
import QRCode from "qrcode";
import { config, nowStamp, todayISO } from "./config";
import { updateCell } from "./sheets";
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
  buildSlotButtons,
  loadMasterclasses,
  loadMCRegistrations,
  loadMCSchedule,
  loadMCTabRows,
  loadMCTopics,
  Masterclass,
  register,
  splitResponsibleNames,
  todaySlots,
  topicLines,
  unregister,
} from "./masterclasses";
import { loadTodaySchedule } from "./schedule";
import { M, roleCapabilitiesText } from "./messages";
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
  removeResponsibleByRow,
  searchResponsibleByName,
} from "./responsible";
import { loadCatches, logCatch } from "./phishing";

export const bot = new Bot(config.botToken);

const isSuperAdmin = (id?: number) => !!id && config.adminIds.includes(id);

async function getUserRoles(
  telegramId: number,
): Promise<{ isVisitor: boolean; isLeader: boolean; isResponsible: boolean }> {
  const [{ leaders }, { responsible }, { visitors }] = await Promise.all([
    loadLeaders(),
    loadResponsible(),
    loadVisitors(),
  ]);
  return {
    isVisitor: !!findByTelegramId(visitors, telegramId),
    isLeader: findLeadersByTelegramId(leaders, telegramId).length > 0,
    isResponsible: findResponsibleByTelegramId(responsible, telegramId).length > 0,
  };
}

function keyboardFromRoles(roles: {
  isVisitor: boolean;
  isLeader: boolean;
  isResponsible: boolean;
}): import("grammy").Keyboard | undefined {
  if (roles.isLeader || roles.isResponsible) {
    return roleKeyboard({ leader: roles.isLeader, responsible: roles.isResponsible });
  }
  if (roles.isVisitor) return roleKeyboard();
  return undefined;
}

async function keyboardForUser(telegramId: number): Promise<import("grammy").Keyboard | undefined> {
  return keyboardFromRoles(await getUserRoles(telegramId));
}

// --- check-in ---

bot.command("start", async (ctx) => {
  const payload = (ctx.match ?? "").trim();
  const medMatch = /^med_(\d+)$/.exec(payload);
  if (medMatch) return handleDoctorScan(ctx, Number(medMatch[1]));
  if (payload === "caught") {
    try {
      await logCatch(String(ctx.from!.id));
    } catch (err) {
      // A failed sheet write shouldn't stop the reveal reply — many people click this link
      // within the same minute, and Sheets can hiccup under that burst.
      console.error("phishing: logCatch failed", err);
    }
    return ctx.reply(M.phishCaught);
  }

  const { visitors } = await loadVisitors();
  const me = findByTelegramId(visitors, ctx.from!.id);
  if (me) {
    const kb = await keyboardForUser(ctx.from!.id);
    return ctx.reply(M.alreadyLinked(me.name), kb ? { reply_markup: kb } : {});
  }
  return ctx.reply(M.welcome);
});

/** Admin scanned a participant's personal QR -> mark the medical exam and push the next step. */
async function handleDoctorScan(ctx: Context, targetId: number) {
  const { admins } = await loadAdmins();
  if (!isSuperAdmin(ctx.from!.id) && !isAdmin(ctx.from!.id, admins)) {
    return ctx.reply(M.medNotAdmin);
  }

  const sheet = await loadVisitors();
  const visitor = findByTelegramId(sheet.visitors, targetId);
  if (!visitor) return ctx.reply(M.medVisitorNotFound);
  if (visitor.doctorStatus) return ctx.reply(M.medAlreadyDone(visitor.name));

  await updateCell(config.responsesTab, visitor.rowIndex, sheet.cols.doctorStatus, nowStamp());
  await ctx.reply(M.medMarked(visitor.name));

  try {
    await bot.api.sendMessage(targetId, M.medPassed, {
      reply_markup: new InlineKeyboard().text(M.btnCheckAnya, "checkanya"),
    });
  } catch {
    // Participant may have blocked the bot; the admin confirmation above still stands.
  }
}

bot.command("myid", async (ctx) => {
  await ctx.reply(M.yourId(ctx.from!.id), { parse_mode: "HTML" });
});

bot.command("help", async (ctx) => {
  const roles = await getUserRoles(ctx.from!.id);
  if (!roles.isVisitor && !roles.isLeader && !roles.isResponsible) {
    return ctx.reply(`${M.generalInfo}\n\n${M.mustCheckInFirst}`);
  }
  return ctx.reply(roleCapabilitiesText(roles));
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

  // Re-link of an already-processed participant: skip straight to the final message.
  if (visitor.doctorStatus && visitor.paymentStatus) {
    return sendFinalMessage(ctx, visitor);
  }

  // Otherwise send the personal QR the doctor scans to mark the medical exam.
  if (config.botUsername) {
    const url = `https://t.me/${config.botUsername}?start=med_${ctx.from.id}`;
    const png = await QRCode.toBuffer(url, { width: 512, margin: 2 });
    await ctx.replyWithPhoto(new InputFile(png, "med-qr.png"), { caption: M.medQrCaption });
  } else {
    await ctx.reply(M.medQrNoUsername);
  }
});

/**
 * Final registration message: team, leader names, room, then the role keyboard,
 * capabilities, and the team video. Both call sites run in the participant's own context.
 */
async function sendFinalMessage(ctx: Context, visitor: { team: string; room: string }) {
  const { leaders } = await loadLeaders();
  const leaderNames = leaders
    .filter((l) => l.team === visitor.team)
    .map((l) => l.name)
    .join(", ");

  const roles = await getUserRoles(ctx.from!.id);
  const kb = keyboardFromRoles(roles);
  await ctx.reply(
    M.registrationComplete({
      team: visitor.team || undefined,
      leaders: leaderNames || undefined,
      room: visitor.room || undefined,
    }),
    kb ? { reply_markup: kb } : {},
  );
  await ctx.reply(roleCapabilitiesText(roles));

  const video = await videoForTeam(visitor.team);
  if (video) {
    if (video.isVideoNote) {
      await ctx.replyWithVideoNote(video.fileId);
    } else {
      await ctx.replyWithVideo(video.fileId, { caption: M.videoCaption });
    }
  }
}

// Participant taps "Я пройшов(ла) Аню" -> send the final message once payment is marked.
bot.callbackQuery("checkanya", async (ctx) => {
  const { visitors } = await loadVisitors();
  const me = findByTelegramId(visitors, ctx.from.id);
  if (!me) return ctx.answerCallbackQuery(M.mustCheckInFirst);
  if (!me.doctorStatus || !me.paymentStatus) {
    return ctx.answerCallbackQuery({ text: M.anyaNotYet, show_alert: true });
  }
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();
  await sendFinalMessage(ctx, me);
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
  const roles = await getUserRoles(ctx.from.id);
  const kb = keyboardFromRoles(roles);
  await ctx.reply(M.leaderCheckedIn(leader.name, leader.team), kb ? { reply_markup: kb } : {});
  await ctx.reply(roleCapabilitiesText(roles));
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
  const roles = await getUserRoles(ctx.from.id);
  const kb = keyboardFromRoles(roles);
  await ctx.reply(M.respCheckedIn(row.name, titles), kb ? { reply_markup: kb } : {});
  await ctx.reply(roleCapabilitiesText(roles));
});

// --- masterclasses ---

async function handleMasterclasses(ctx: Context) {
  const [tabRows, regs] = await Promise.all([loadMCTabRows(), loadMCRegistrations()]);
  const mcs = await loadMasterclasses(tabRows);
  const schedule = await loadMCSchedule(tabRows);
  const topics = await loadMCTopics(tabRows);
  const slots = todaySlots(schedule);
  const kb = new InlineKeyboard();
  const topicsLines: string[] = [];
  let anyListed = false;
  for (const s of slots) {
    const buttons = buildSlotButtons(s, mcs, regs, String(ctx.from!.id));
    if (buttons.length === 0) continue;
    kb.text(`— ${s.slot} —`, "mcnoop").row();
    for (const b of buttons) kb.text(b.label, b.cbData).row();
    topicsLines.push(...topicLines(s.mcIds, mcs, topics, s.date));
    anyListed = true;
  }
  if (!anyListed) return ctx.reply(M.noMasterclassesToday);
  const body = topicsLines.length
    ? [M.mcDayTitle, "", ...topicsLines].join("\n")
    : M.mcDayTitle;
  return ctx.reply(body, { reply_markup: kb });
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
  const tabRows = await loadMCTabRows();
  const [mcs, regs, topics] = await Promise.all([
    loadMasterclasses(tabRows),
    loadMCRegistrations(),
    loadMCTopics(tabRows),
  ]);
  const today = todayISO();
  const mine = regs.filter(
    (r) => r.telegramId === String(ctx.from!.id) && !r.cancelled && r.date >= today,
  );
  if (mine.length === 0) return ctx.reply(M.myRegsEmpty);
  const lines = [M.myRegsTitle, ""];
  for (const r of mine) {
    const mc = mcs.find((m) => m.id === r.mcId);
    if (mc) {
      const topic = topics.get(`${r.date}|${r.mcId}`);
      lines.push(`• ${r.date}, ${r.slot} — ${M.mcTitleWithTopic(mc.title, topic)} (${mc.place})`);
    }
  }
  return ctx.reply(lines.join("\n"));
}

bot.command("mc", handleMasterclasses);
bot.command("schedule", handleSchedule);
bot.command("myevents", handleMyRegs);

bot.callbackQuery(/^mcreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  if (date !== todayISO()) return ctx.answerCallbackQuery(M.noMasterclassesToday);
  const tabRows = await loadMCTabRows();
  const [mcs, topics, { visitors }] = await Promise.all([
    loadMasterclasses(tabRows),
    loadMCTopics(tabRows),
    loadVisitors(),
  ]);
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
      ? M.mcRegistered(mc.title, slot, mc.place)
      : result === "full"
        ? M.mcFull
        : result === "already"
          ? M.mcAlready
          : M.mcSlotTaken,
  );
  if (result === "ok") {
    const topic = topics.get(`${date}|${mcId}`);
    await ctx.reply(M.mcRegistered(mc.title, slot, mc.place, topic));
  }
  if (result === "slot_taken") await ctx.reply(M.mcSlotTaken);
});

bot.callbackQuery(/^mcunreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  if (date !== todayISO()) return ctx.answerCallbackQuery(M.noMasterclassesToday);
  const mcs = await loadMasterclasses();
  const mc = mcs.find((m) => m.id === mcId);
  const ok = await unregister(date, slot, mcId, ctx.from.id);
  await ctx.answerCallbackQuery();
  if (ok && mc) await ctx.reply(M.mcUnregistered(mc.title, slot));
});

// Inert tap target for the slot-header row in the combined masterclass list.
bot.callbackQuery("mcnoop", (ctx) => ctx.answerCallbackQuery());

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

async function buildDelRespPicker(): Promise<{ text: string; kb: InlineKeyboard } | null> {
  const [{ responsible }, mcs] = await Promise.all([loadResponsible(), loadMasterclasses()]);
  if (responsible.length === 0) return null;
  const kb = new InlineKeyboard();
  const knownIds = new Set(mcs.map((m) => m.id));
  const groups = [
    ...mcs.map((mc) => ({ title: mc.title, rows: responsible.filter((r) => r.mcId === mc.id) })),
    ...[...new Set(responsible.filter((r) => !knownIds.has(r.mcId)).map((r) => r.mcId))].map(
      (mcId) => ({ title: `МК ${mcId}`, rows: responsible.filter((r) => r.mcId === mcId) }),
    ),
  ];
  for (const g of groups) {
    if (g.rows.length === 0) continue;
    kb.text(`— ${g.title} —`, "mcnoop").row();
    for (const r of g.rows) kb.text(`❌ ${r.name}`, `delresp:${r.rowIndex}`).row();
  }
  return { text: M.delRespPickerTitle, kb };
}

bot.command("delresp", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const picker = await buildDelRespPicker();
  if (!picker) return ctx.reply(M.noResponsiblePersons);
  return ctx.reply(picker.text, { reply_markup: picker.kb });
});

bot.callbackQuery(/^delresp:(\d+)$/, async (ctx) => {
  const rowIndex = Number(ctx.match[1]);
  const { responsible } = await loadResponsible();
  const row = responsible.find((r) => r.rowIndex === rowIndex);
  await ctx.answerCallbackQuery();
  if (!row) return ctx.editMessageText(M.delRespGone);
  const mcs = await loadMasterclasses();
  const title = mcs.find((m) => m.id === row.mcId)?.title ?? `МК ${row.mcId}`;
  const kb = new InlineKeyboard()
    .text("✅ Так, видалити", `delrespyes:${rowIndex}`)
    .text("↩️ Скасувати", "delrespcancel");
  return ctx.editMessageText(M.confirmDelResp(row.name, title), { reply_markup: kb });
});

bot.callbackQuery(/^delrespyes:(\d+)$/, async (ctx) => {
  const rowIndex = Number(ctx.match[1]);
  const { responsible } = await loadResponsible();
  const row = responsible.find((r) => r.rowIndex === rowIndex);
  await ctx.answerCallbackQuery();
  if (!row) return ctx.editMessageText(M.delRespGone);
  await removeResponsibleByRow(rowIndex);
  const mcs = await loadMasterclasses();
  const title = mcs.find((m) => m.id === row.mcId)?.title ?? `МК ${row.mcId}`;
  return ctx.editMessageText(M.respRemoved(row.name, title));
});

bot.callbackQuery("delrespcancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  const picker = await buildDelRespPicker();
  if (!picker) return ctx.editMessageText(M.noResponsiblePersons);
  return ctx.editMessageText(picker.text, { reply_markup: picker.kb });
});

async function replyChunked(ctx: Context, lines: string[], limit = 3500): Promise<void> {
  let buf: string[] = [];
  let len = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (len + lineLen > limit && buf.length > 0) {
      await ctx.reply(buf.join("\n"));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += lineLen;
  }
  if (buf.length > 0) await ctx.reply(buf.join("\n"));
}

bot.command("syncresp", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const mcs = await loadMasterclasses();
  if (mcs.length === 0) return ctx.reply(M.mcCatalogUnavailable);
  const lines: string[] = [M.mcSyncTitle, ""];
  let added = 0;
  let existing = 0;
  for (const mc of mcs) {
    for (const name of splitResponsibleNames(mc.responsible)) {
      const result = await addResponsible(mc.id, name);
      if (result === "ok") {
        lines.push(M.mcSyncAdded(name, mc.title));
        added++;
      } else {
        lines.push(M.mcSyncDuplicate(name, mc.title));
        existing++;
      }
    }
  }
  lines.push("", M.mcSyncSummary(added, existing));
  return replyChunked(ctx, lines);
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

// --- responsible tools ---

interface MCOccurrence {
  date: string;
  slot: string;
  mc: Masterclass;
}

/** Today's occurrences of the user's masterclasses, in deterministic sheet order.
 *  Returns null if the user is not a responsible person. */
async function myOccurrencesToday(telegramId: number): Promise<MCOccurrence[] | null> {
  const { responsible } = await loadResponsible();
  const mine = findResponsibleByTelegramId(responsible, telegramId);
  if (mine.length === 0) return null;
  const myIds = [...new Set(mine.map((r) => r.mcId))];
  const tabRows = await loadMCTabRows();
  const mcs = await loadMasterclasses(tabRows);
  const schedule = await loadMCSchedule(tabRows);
  const occ: MCOccurrence[] = [];
  for (const s of todaySlots(schedule)) {
    for (const id of s.mcIds) {
      if (!myIds.includes(id)) continue;
      const mc = mcs.find((m) => m.id === id);
      if (mc) occ.push({ date: s.date, slot: s.slot, mc });
    }
  }
  return occ;
}

async function handleMcAttendees(ctx: Context) {
  const occ = await myOccurrencesToday(ctx.from!.id);
  if (occ === null) return ctx.reply(M.notResponsible);
  if (occ.length === 0) return ctx.reply(M.noMyMcToday);
  const regs = await loadMCRegistrations();
  const lines: string[] = [];
  for (const o of occ) {
    const taken = activeRegs(regs, o.date, o.slot, o.mc.id);
    lines.push(M.mcAttendeesHeader(o.mc.title, o.slot, o.mc.place, taken.length, o.mc.capacity));
    if (taken.length === 0) lines.push(M.mcNoAttendees);
    for (const r of taken) lines.push(`• ${r.name}`);
    lines.push("");
  }
  return ctx.reply(lines.join("\n").trimEnd());
}

/** Entities fully contained in [offset, offset+length) of the original text,
 *  rebased to start at 0 — e.g. a text_link entity over the command's payload
 *  survives being re-sent as a standalone message. Entities that start before
 *  `offset` (like the command's own `bot_command` entity) are dropped. */
function sliceEntities(
  entities: MessageEntity[] | undefined,
  offset: number,
  length: number,
): MessageEntity[] {
  if (!entities) return [];
  return entities
    .filter((e) => e.offset >= offset && e.offset + e.length <= offset + length)
    .map((e) => ({ ...e, offset: e.offset - offset }));
}

async function notifyOccurrence(
  ctx: Context,
  o: MCOccurrence,
  text: string,
  entities?: MessageEntity[],
) {
  const regs = await loadMCRegistrations();
  const taken = activeRegs(regs, o.date, o.slot, o.mc.id);
  const ids = [...new Set(taken.map((r) => r.telegramId))];
  let sent = 0;
  for (const id of ids) {
    try {
      await bot.api.sendMessage(id, text, { entities });
      sent++;
    } catch {
      // user blocked the bot or never started it
    }
  }
  return ctx.reply(M.mcNotifySent(sent, ids.length, o.mc.title, o.slot));
}

bot.command("notifymc", async (ctx) => {
  const text = ctx.match.trim();
  if (!text) return ctx.reply(M.mcNotifyNoText);
  const occ = await myOccurrencesToday(ctx.from!.id);
  if (occ === null) return ctx.reply(M.notResponsible);
  if (occ.length === 0) return ctx.reply(M.noMyMcToday);
  // Responsible people run exactly one MC per day, so this is always occ.length === 1
  // in practice — the picker below is a defensive fallback for multiple occurrences,
  // and (unlike this path) doesn't preserve rich-text entities like links.
  if (occ.length === 1) {
    const payloadOffset = (ctx.message?.text ?? "").length - ctx.match.length;
    const entities = sliceEntities(ctx.message?.entities, payloadOffset, text.length);
    return notifyOccurrence(ctx, occ[0], text, entities);
  }
  const kb = new InlineKeyboard();
  occ.forEach((o, i) => kb.text(`${o.mc.title} (${o.slot})`, `mn:${i}`).row());
  return ctx.reply(M.mcNotifyChoose(text), { reply_markup: kb });
});

bot.callbackQuery(/^mn:(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  // The notify text is embedded in the picker message («…»), like the renameteam flow.
  const msgText = ctx.callbackQuery.message?.text ?? "";
  const textMatch = msgText.match(/«([\s\S]+)»/);
  if (!textMatch) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.mcNotifyNoText);
  }
  const occ = await myOccurrencesToday(ctx.from.id);
  const o = occ?.[idx];
  if (!o) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(M.noMyMcToday);
  }
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();
  return notifyOccurrence(ctx, o, textMatch[1]);
});

async function renderCaught(ctx: Context, o: MCOccurrence) {
  const [regs, catches] = await Promise.all([loadMCRegistrations(), loadCatches()]);
  const taken = activeRegs(regs, o.date, o.slot, o.mc.id);
  const earliestByTelegramId = new Map<string, string>();
  for (const c of catches) {
    if (!c.caughtAt.startsWith(o.date)) continue; // only count clicks from this occurrence's day
    const existing = earliestByTelegramId.get(c.telegramId);
    if (!existing || c.caughtAt < existing) earliestByTelegramId.set(c.telegramId, c.caughtAt);
  }
  const caught = taken
    .filter((r) => earliestByTelegramId.has(r.telegramId))
    .map((r) => ({ name: r.name, caughtAt: earliestByTelegramId.get(r.telegramId)! }))
    .sort((a, b) => a.caughtAt.localeCompare(b.caughtAt));
  const lines = [M.caughtHeader(o.mc.title, o.slot)];
  if (caught.length === 0) lines.push(M.noCatches);
  else for (const c of caught) lines.push(`• ${c.name} — ${c.caughtAt}`);
  return ctx.reply(lines.join("\n"));
}

bot.command("caught", async (ctx) => {
  const occ = await myOccurrencesToday(ctx.from!.id);
  if (occ === null) return ctx.reply(M.notResponsible);
  if (occ.length === 0) return ctx.reply(M.noMyMcToday);
  if (occ.length === 1) return renderCaught(ctx, occ[0]);
  const kb = new InlineKeyboard();
  occ.forEach((o, i) => kb.text(`${o.mc.title} (${o.slot})`, `cn:${i}`).row());
  return ctx.reply(M.caughtChoose, { reply_markup: kb });
});

bot.callbackQuery(/^cn:(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  const occ = await myOccurrencesToday(ctx.from.id);
  const o = occ?.[idx];
  await ctx.answerCallbackQuery();
  if (!o) return ctx.editMessageText(M.noMyMcToday);
  await ctx.deleteMessage();
  return renderCaught(ctx, o);
});

// --- keyboard button handlers (must be before message:text catch-all) ---

bot.hears(BTN.masterclasses, handleMasterclasses);
bot.hears(BTN.schedule, handleSchedule);
bot.hears(BTN.myRegs, handleMyRegs);
bot.hears(BTN.notifyTeam, (ctx) => ctx.reply(M.notifyTeamHint));
bot.hears(BTN.renameTeam, (ctx) => ctx.reply(M.renameTeamHint));
bot.hears(BTN.mcAttendees, handleMcAttendees);
bot.hears(BTN.mcNotify, (ctx) => ctx.reply(M.mcNotifyHint));

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
