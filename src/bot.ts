import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { MessageEntity } from "grammy/types";
import QRCode from "qrcode";
import { config, nowStamp, todayISO } from "./config";
import { updateCell } from "./sheets";
import {
  findByTelegramId,
  isMeaningfulNeed,
  linkAndCheckIn,
  loadVisitors,
  renameTeamVideo,
  renameVisitorTeams,
  searchByName,
  updateTeamVideo,
  videoForTeam,
  visitorsByTeam,
} from "./checkin";
import {
  activeRegs,
  buildSlotButtons,
  loadMasterclasses,
  Masterclass,
  splitResponsibleNames,
  todaySlots,
  topicLines,
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
  addResponsibleMany,
  findResponsibleByTelegramId,
  linkResponsibleRows,
  loadResponsible,
  removeResponsibleByRow,
  searchResponsibleByName,
} from "./responsible";
import { loadCatches, logCatch } from "./phishing";
import {
  asMCRegistrations,
  getMasterclasses,
  getMCSchedule,
  getMCTopics,
  getRegistrations,
  registerMongo,
  syncMCFromSheets,
  unregisterMongo,
} from "./mc-store";
import { mongoEnabled } from "./mongo";
import {
  findVisitorByTelegramIdMongo,
  getVisitorsMongo,
  syncVisitorsFromSheets,
  upsertVisitorMongo,
} from "./visitor-store";

export const bot = new Bot(config.botToken);

const isSuperAdmin = (id?: number) => !!id && config.adminIds.includes(id);

/** Everything the three role sheets say about one person, from a single batched read.
 *  Handlers that need both a role check and the underlying rows (check-in, /start,
 *  name search) must use this rather than re-loading a tab they already have — the
 *  whole camp shares one 60 reads/minute quota, so a duplicate read is a real cost. */
async function loadRoleContext(telegramId: number) {
  const [leaderSheet, respSheet, sheet] = await Promise.all([
    loadLeaders(),
    loadResponsible(),
    loadVisitors(),
  ]);
  const visitor = findByTelegramId(sheet.visitors, telegramId);
  const asLeader = findLeadersByTelegramId(leaderSheet.leaders, telegramId);
  const asResponsible = findResponsibleByTelegramId(respSheet.responsible, telegramId);
  return {
    sheet,
    leaders: leaderSheet.leaders,
    responsible: respSheet.responsible,
    visitor,
    asLeader,
    asResponsible,
    roles: {
      isVisitor: !!visitor,
      isLeader: asLeader.length > 0,
      isResponsible: asResponsible.length > 0,
    },
  };
}

async function getUserRoles(
  telegramId: number,
): Promise<{ isVisitor: boolean; isLeader: boolean; isResponsible: boolean }> {
  return (await loadRoleContext(telegramId)).roles;
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

/** Reply to a role-gated button pressed by someone who no longer holds that role.
 *  Telegram keeps reply keyboards on the client, so a keyboard sent while the user
 *  was a leader/responsible survives their removal from the sheet until the bot
 *  sends new markup — do that here so the stale buttons disappear on first press. */
async function replyRoleRevoked(ctx: Context, text: string) {
  const kb = await keyboardForUser(ctx.from!.id);
  return ctx.reply(text, { reply_markup: kb ?? { remove_keyboard: true } });
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

  // One batched read covers both "is this person already linked?" and their keyboard.
  const { visitor: me, roles } = await loadRoleContext(ctx.from!.id);
  const kb = keyboardFromRoles(roles);
  if (me) {
    await ctx.reply(M.alreadyLinked(me.name), kb ? { reply_markup: kb } : {});
    // Re-issue the doctor's QR while the medical exam is outstanding. This is the
    // recovery route for a check-in whose first attempt wrote the row but died before
    // sending the QR — /start is the one command every participant knows.
    if (!me.doctorStatus) await sendMedQr(ctx);
    return;
  }
  // A leader/responsible who never checked in as a visitor still gets their keyboard —
  // /start is the one command everyone knows, so it must repair a missing one.
  await ctx.reply(M.welcome, kb ? { reply_markup: kb } : {});
  return ctx.reply(M.askName);
});

/** Admin scanned a participant's personal QR -> mark the medical exam and push the next step. */
async function handleDoctorScan(ctx: Context, targetId: number) {
  // Both tabs in one batched read — the doctor scans on the same quota as the queue.
  const [{ admins }, sheet] = await Promise.all([loadAdmins(), loadVisitors()]);
  if (!isSuperAdmin(ctx.from!.id) && !isAdmin(ctx.from!.id, admins)) {
    return ctx.reply(M.medNotAdmin);
  }

  const visitor = findByTelegramId(sheet.visitors, targetId);
  if (!visitor) return ctx.reply(M.medVisitorNotFound);
  if (visitor.doctorStatus) return ctx.reply(M.medAlreadyDone(visitor.name));

  await updateCell(config.responsesTab, visitor.rowIndex, sheet.cols.doctorStatus, nowStamp());
  await ctx.reply(M.medMarked(visitor.name, visitor.specialNeeds));

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
  // Roles are already loaded here, so send the matching keyboard along — this is how
  // someone whose role was added straight in the sheet picks up their buttons.
  const kb = keyboardFromRoles(roles);
  return ctx.reply(
    `${roleCapabilitiesText(roles)}\n\n${M.infoChannel}`,
    kb ? { reply_markup: kb } : {},
  );
});

// Leader linking is command-gated: the name arrives as the command argument, so a plain
// text message never searches the Leaders table. See docs/superpowers/specs/2026-08-01-*.
bot.command("leader", async (ctx) => {
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from!.id);
  if (mine.length > 0) {
    // Re-running /leader is what an already-linked leader tries when their buttons are
    // missing, so answer with the keyboard rather than just the "already linked" text.
    const kb = await keyboardForUser(ctx.from!.id);
    return ctx.reply(
      M.leaderAlreadyLinked(mine[0].name, mine[0].team),
      kb ? { reply_markup: kb } : {},
    );
  }

  const query = ctx.match.trim();
  if (!query) return ctx.reply(M.leaderPrompt);

  // searchLeaderByName only returns rows that nobody has claimed yet.
  const matches = searchLeaderByName(leaders, query);
  if (matches.length === 0) return ctx.reply(M.leaderNotFound);

  const kb = new InlineKeyboard();
  if (matches.length === 1) {
    const l = matches[0];
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
    return ctx.reply(M.confirmLeader(l.name, l.team), { reply_markup: kb });
  }
  for (const l of matches) {
    kb.text(`👑 ${l.name} (${l.team})`, `link_leader:${l.rowIndex}`).row();
  }
  return ctx.reply(M.chooseYourself, { reply_markup: kb });
});

// Mirrors /leader. One person may run several masterclasses (several MCResponsible rows);
// the dedup below shows one button per person, and link_resp: links all of their rows.
bot.command("responsible", async (ctx) => {
  const sheet = await loadResponsible();
  const mine = findResponsibleByTelegramId(sheet.responsible, ctx.from!.id);
  if (mine.length > 0) {
    const kb = await keyboardForUser(ctx.from!.id);
    return ctx.reply(M.respAlreadyLinked(mine[0].name), kb ? { reply_markup: kb } : {});
  }

  const query = ctx.match.trim();
  if (!query) return ctx.reply(M.respPrompt);

  const rows = searchResponsibleByName(sheet.responsible, query);
  const matches = [...new Map(rows.map((r) => [r.name.toLowerCase(), r])).values()];
  if (matches.length === 0) return ctx.reply(M.respNotFound);

  const kb = new InlineKeyboard();
  if (matches.length === 1) {
    const r = matches[0];
    kb.text(`🎨 ${r.name}`, `link_resp:${r.rowIndex}`).row();
    return ctx.reply(M.confirmResp(r.name), { reply_markup: kb });
  }
  for (const r of matches) {
    kb.text(`🎨 ${r.name}`, `link_resp:${r.rowIndex}`).row();
  }
  return ctx.reply(M.chooseYourself, { reply_markup: kb });
});

/** Telegram housekeeping that must never abort a handler. Dismissing the spinner,
 *  editing and deleting are all cosmetic, but a throw here after the check-in row is
 *  already written leaves the participant checked in with nothing to show for it —
 *  the update 500s, Telegram redelivers, and the retry takes the "already linked"
 *  branch instead of sending the QR. */
async function tryTelegram(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`telegram: ${what} failed`, err);
  }
}

/** answerCallbackQuery only dismisses the client's loading spinner and optionally shows
 *  a toast. Telegram invalidates the query about 15 seconds after the tap, so under load
 *  it fails routinely with "query is too old" — and it must never abort a handler that
 *  has already written to a sheet, which is how check-ins ended up recorded with the QR
 *  never sent. Every callback handler answers through here; anything the participant
 *  actually needs to read is sent as a normal message, not as a toast. */
function safeAnswer(
  ctx: Context,
  ...args: Parameters<Context["answerCallbackQuery"]>
): Promise<void> {
  return tryTelegram("answerCallbackQuery", () => ctx.answerCallbackQuery(...args));
}

/** Wraps a Mongo-backed handler. On failure it logs and answers with M.tryAgainLater
 *  instead of throwing — there is no global bot.catch, so an uncaught error becomes
 *  HTTP 500 and Telegram redelivers the same update in a loop. */
function mongoGuarded<C extends Context>(
  handler: (ctx: C) => Promise<unknown>,
): (ctx: C) => Promise<void> {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (err) {
      console.error("mongo-backed handler failed", err);
      if (ctx.callbackQuery) await safeAnswer(ctx as never, M.tryAgainLater);
      await ctx.reply(M.tryAgainLater).catch(() => {});
    }
  };
}

/** The personal QR the doctor scans to mark the medical exam. Safe to send more than
 *  once, so it doubles as the recovery path for a check-in whose first attempt died. */
async function sendMedQr(ctx: Context): Promise<unknown> {
  if (!config.botUsername) return ctx.reply(M.medQrNoUsername);
  const url = `https://t.me/${config.botUsername}?start=med_${ctx.from!.id}`;
  const png = await QRCode.toBuffer(url, { width: 512, margin: 2 });
  return ctx.replyWithPhoto(new InputFile(png, "med-qr.png"), { caption: M.medQrCaption });
}

bot.callbackQuery(/^link:(\d+)$/, async (ctx) => {
  // Answer before touching the sheet. Telegram invalidates a callback query about 15
  // seconds after the tap, and the reads below can outlast that under load — answering
  // afterwards used to throw ("query is too old") once the row had already been written.
  await safeAnswer(ctx);

  const rowIndex = Number(ctx.match[1]);
  const sheet = await loadVisitors();

  const already = findByTelegramId(sheet.visitors, ctx.from.id);
  if (already) {
    await tryTelegram("editMessageText", () => ctx.editMessageText(M.alreadyLinked(already.name)));
    // Recovery: a redelivered update or a second tap must still hand over the QR while
    // the medical exam is outstanding, otherwise it is lost for good.
    if (!already.doctorStatus) return sendMedQr(ctx);
    return;
  }

  const { ok, visitor } = await linkAndCheckIn(sheet, rowIndex, ctx.from.id);
  if (!ok || !visitor) {
    return tryTelegram("editMessageText", () => ctx.editMessageText(M.rowTaken));
  }

  if (mongoEnabled()) {
    // Best-effort: check-in is Sheets-owned and must not break on a Mongo outage.
    upsertVisitorMongo({
      ...visitor,
      telegramId: String(ctx.from.id),
      checkedIn: visitor.checkedIn || nowStamp(),
    }).catch((err) => console.error("visitor write-through failed", err));
  }

  await tryTelegram("deleteMessage", () => ctx.deleteMessage());

  // Re-link of an already-processed participant: skip straight to the final message.
  if (visitor.doctorStatus && visitor.paymentStatus) {
    return sendFinalMessage(ctx, visitor);
  }

  return sendMedQr(ctx);
});

/**
 * Final registration message: team, leader names, room, then the role keyboard,
 * capabilities, and the team video. Both call sites run in the participant's own context.
 */
async function sendFinalMessage(
  ctx: Context,
  visitor: { team: string; room: string },
  // Pass a context only when the caller already knows the roles are current. The
  // check-in path must NOT: it reads the sheet before writing the Telegram ID, so a
  // reused context would still say isVisitor=false and the keyboard would go missing.
  preloaded?: Awaited<ReturnType<typeof loadRoleContext>>,
) {
  // Leaders, roles and the team video are fetched together so this whole message —
  // the busiest moment of check-in — costs a single Sheets read request.
  const [{ leaders, roles }, video] = await Promise.all([
    preloaded ?? loadRoleContext(ctx.from!.id),
    videoForTeam(visitor.team),
  ]);
  const leaderNames = leaders
    .filter((l) => l.team === visitor.team)
    .map((l) => l.name)
    .join(", ");

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
  await ctx.reply(M.infoChannel);

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
  // Already linked by definition here, so the roles in this context stay valid for
  // the final message — hand it over instead of reading the same three tabs again.
  const context = await loadRoleContext(ctx.from.id);
  const me = context.visitor;
  if (!me) return safeAnswer(ctx, M.mustCheckInFirst);
  if (!me.doctorStatus || !me.paymentStatus) {
    return safeAnswer(ctx, { text: M.anyaNotYet, show_alert: true });
  }
  await safeAnswer(ctx);
  await ctx.deleteMessage();
  await sendFinalMessage(ctx, me, context);
});

// Role-linking (👑/🎨) buttons stay valid in Telegram forever, so someone scrolling up in
// old chat history could tap a button sent before this staleness guard existed. Rejecting
// taps on messages older than this window forces a fresh /leader or /responsible run.
const ROLE_LINK_MAX_AGE_MS = 10 * 60 * 1000;

function isStaleRoleLinkTap(ctx: Context): boolean {
  const messageDate = ctx.callbackQuery?.message?.date;
  if (!messageDate) return true; // missing or inaccessible (date === 0): fail closed
  return Date.now() - messageDate * 1000 > ROLE_LINK_MAX_AGE_MS;
}

bot.callbackQuery(/^link_leader:(\d+)$/, async (ctx) => {
  if (isStaleRoleLinkTap(ctx)) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.leaderPrompt);
  }

  const rowIndex = Number(ctx.match[1]);
  const leaderSheet = await loadLeaders();

  const alreadyLinked = findLeadersByTelegramId(leaderSheet.leaders, ctx.from.id);
  if (alreadyLinked.length > 0) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.leaderAlreadyLinked(alreadyLinked[0].name, alreadyLinked[0].team));
  }

  const leader = leaderSheet.leaders.find((l) => l.rowIndex === rowIndex);
  if (!leader) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.leaderNotFound);
  }
  if (leader.telegramId && leader.telegramId !== String(ctx.from.id)) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.rowTaken);
  }

  await setLeaderTelegramId(leaderSheet, rowIndex, ctx.from.id);
  await safeAnswer(ctx);
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
  if (isStaleRoleLinkTap(ctx)) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.respPrompt);
  }

  const rowIndex = Number(ctx.match[1]);
  const sheet = await loadResponsible();

  const already = findResponsibleByTelegramId(sheet.responsible, ctx.from.id);
  if (already.length > 0) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.respAlreadyLinked(already[0].name));
  }

  const row = sheet.responsible.find((r) => r.rowIndex === rowIndex);
  if (!row) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.respNotFound);
  }
  if (row.telegramId && row.telegramId !== String(ctx.from.id)) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.rowTaken);
  }

  // Links every unlinked row with this name — one person may run several MCs.
  const linked = await linkResponsibleRows(sheet, row.name, ctx.from.id);
  await safeAnswer(ctx);
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
  const [mcs, schedule, topics, regsRaw] = await Promise.all([
    getMasterclasses(),
    getMCSchedule(),
    getMCTopics(),
    getRegistrations(),
  ]);
  const regs = asMCRegistrations(regsRaw);
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
  const body = topicsLines.length ? [M.mcDayTitle, "", ...topicsLines].join("\n") : M.mcDayTitle;
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
  const [mcs, topics, regs] = await Promise.all([
    getMasterclasses(),
    getMCTopics(),
    getRegistrations(),
  ]);
  const today = todayISO();
  const mine = regs.filter(
    (r) => r.telegramId === String(ctx.from!.id) && r.active && r.date >= today,
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

bot.command("mc", mongoGuarded(handleMasterclasses));
bot.command("schedule", handleSchedule);
bot.command("myevents", mongoGuarded(handleMyRegs));

bot.callbackQuery(/^mcreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, mongoGuarded(async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  if (date !== todayISO()) return safeAnswer(ctx, M.noMasterclassesToday);
  const [mcs, topics, me] = await Promise.all([
    getMasterclasses(),
    getMCTopics(),
    findVisitorByTelegramIdMongo(ctx.from.id),
  ]);
  const mc = mcs.find((m) => m.id === mcId);
  if (!mc) return safeAnswer(ctx);
  if (!me) {
    await safeAnswer(ctx);
    return ctx.reply(M.mustCheckInFirst);
  }
  const result = await registerMongo(date, slot, mcId, mc.capacity, ctx.from.id);
  await safeAnswer(
    ctx,
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
}));

bot.callbackQuery(/^mcunreg:(\d{4}-\d{2}-\d{2}):(.+):([^:]+)$/, mongoGuarded(async (ctx) => {
  const [, date, slot, mcId] = ctx.match;
  if (date !== todayISO()) return safeAnswer(ctx, M.noMasterclassesToday);
  const mcs = await getMasterclasses();
  const mc = mcs.find((m) => m.id === mcId);
  const ok = await unregisterMongo(date, slot, mcId, ctx.from.id);
  await safeAnswer(ctx);
  if (ok && mc) await ctx.reply(M.mcUnregistered(mc.title, slot));
}));

// Inert tap target for the slot-header row in the combined masterclass list.
bot.callbackQuery("mcnoop", (ctx) => safeAnswer(ctx));

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
  await safeAnswer(ctx);
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
  await safeAnswer(ctx);
  if (!row) return ctx.editMessageText(M.delRespGone);
  await removeResponsibleByRow(rowIndex);
  const mcs = await loadMasterclasses();
  const title = mcs.find((m) => m.id === row.mcId)?.title ?? `МК ${row.mcId}`;
  return ctx.editMessageText(M.respRemoved(row.name, title));
});

bot.callbackQuery("delrespcancel", async (ctx) => {
  await safeAnswer(ctx);
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
  // Flatten first: one read + one append for the whole catalog. Adding per name in a
  // loop used to issue a read per name and could exhaust the quota on its own.
  const entries = mcs.flatMap((mc) =>
    splitResponsibleNames(mc.responsible).map((name) => ({ mcId: mc.id, name, title: mc.title })),
  );
  const results = await addResponsibleMany(entries);
  entries.forEach((e, i) => {
    if (results[i] === "ok") {
      lines.push(M.mcSyncAdded(e.name, e.title));
      added++;
    } else {
      lines.push(M.mcSyncDuplicate(e.name, e.title));
      existing++;
    }
  });
  lines.push("", M.mcSyncSummary(added, existing));
  return replyChunked(ctx, lines);
});

bot.command("syncmc", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  try {
    const counts = await syncMCFromSheets();
    return ctx.reply(M.mcSynced(counts.masterclasses, counts.slots, counts.topics));
  } catch (err) {
    console.error("syncmc failed", err);
    return ctx.reply(M.syncFailed);
  }
});

bot.command("syncvisitors", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  try {
    return ctx.reply(M.visitorsSynced(await syncVisitorsFromSheets()));
  } catch (err) {
    console.error("syncvisitors failed", err);
    return ctx.reply(M.syncFailed);
  }
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
    await safeAnswer(ctx);
    return ctx.editMessageText(M.renameTeamNoText);
  }
  const newName = newNameMatch[1];
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, ctx.from.id);
  const myTeams = [...new Set(mine.map((l) => l.team))];
  const oldTeam = myTeams[idx];
  if (!oldTeam) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.notLeader);
  }
  await safeAnswer(ctx);
  const [visitorsCount] = await Promise.all([
    renameVisitorTeams(oldTeam, newName),
    renameLeaderTeams(oldTeam, newName),
    renameTeamVideo(oldTeam, newName),
  ]);
  return ctx.editMessageText(M.renameTeamDone(oldTeam, newName, visitorsCount));
});

// --- leader team views ---

/** Distinct teams the caller leads, in Leaders-sheet order.
 *  Returns null if the caller is not a leader. */
async function myLedTeams(telegramId: number): Promise<string[] | null> {
  const { leaders } = await loadLeaders();
  const mine = findLeadersByTelegramId(leaders, telegramId);
  if (mine.length === 0) return null;
  return [...new Set(mine.map((l) => l.team))];
}

async function handleTeamRoster(ctx: Context) {
  const teams = await myLedTeams(ctx.from!.id);
  if (!teams) return replyRoleRevoked(ctx, M.notLeader);
  const visitors = await getVisitorsMongo();
  const lines: string[] = [];
  for (const team of teams) {
    const members = visitorsByTeam(visitors, team);
    lines.push(M.teamRosterHeader(team, members.length), "");
    if (members.length === 0) lines.push(M.teamEmpty);
    members.forEach((v, i) =>
      lines.push(
        M.teamRosterLine(
          i + 1,
          v.name,
          v.age,
          v.room,
          isMeaningfulNeed(v.specialNeeds) ? v.specialNeeds : "",
        ),
      ),
    );
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return replyChunked(ctx, lines);
}

async function handleTeamMc(ctx: Context) {
  const teams = await myLedTeams(ctx.from!.id);
  if (!teams) return replyRoleRevoked(ctx, M.notLeader);
  const [schedule, mcs, regsRaw, visitors] = await Promise.all([
    getMCSchedule(),
    getMasterclasses(),
    getRegistrations(),
    getVisitorsMongo(),
  ]);
  const slots = todaySlots(schedule);
  if (slots.length === 0) return ctx.reply(M.noMasterclassesToday);
  const regs = asMCRegistrations(regsRaw);

  const lines: string[] = [];
  for (const team of teams) {
    const members = visitorsByTeam(visitors, team);
    lines.push(M.teamMcHeader(team), "");
    if (members.length === 0) {
      lines.push(M.teamEmpty, "");
      continue;
    }
    for (const s of slots) {
      lines.push(s.slot);
      for (const v of members) {
        const reg = v.telegramId
          ? regs.find(
              (r) =>
                r.date === s.date &&
                r.slot === s.slot &&
                r.telegramId === v.telegramId &&
                !r.cancelled,
            )
          : undefined;
        // An unknown MC ID (catalog row deleted) reads as "без реєстрації"
        // rather than leaking a bare numeric ID to the leader.
        const title = reg ? mcs.find((m) => m.id === reg.mcId)?.title : undefined;
        lines.push(M.teamMcLine(v.name, title ?? M.teamMcNone));
      }
      lines.push("");
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return replyChunked(ctx, lines);
}

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
  const [mcs, schedule] = await Promise.all([getMasterclasses(), getMCSchedule()]);
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
  if (occ === null) return replyRoleRevoked(ctx, M.notResponsible);
  if (occ.length === 0) return ctx.reply(M.noMyMcToday);
  const [regsRaw, visitors] = await Promise.all([getRegistrations(), getVisitorsMongo()]);
  const regs = asMCRegistrations(regsRaw);
  const nameById = new Map(
    visitors.filter((v) => v.telegramId).map((v) => [v.telegramId, v.name]),
  );
  const lines: string[] = [];
  for (const o of occ) {
    const taken = activeRegs(regs, o.date, o.slot, o.mc.id);
    lines.push(M.mcAttendeesHeader(o.mc.title, o.slot, o.mc.place, taken.length, o.mc.capacity));
    if (taken.length === 0) lines.push(M.mcNoAttendees);
    for (const r of taken)
      lines.push(`• ${nameById.get(r.telegramId) ?? M.mcAttendeeUnknown(r.telegramId)}`);
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
  const regs = asMCRegistrations(await getRegistrations());
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

bot.command("notifymc", mongoGuarded(async (ctx) => {
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
}));

bot.callbackQuery(/^mn:(\d+)$/, mongoGuarded(async (ctx) => {
  const idx = Number(ctx.match[1]);
  // The notify text is embedded in the picker message («…»), like the renameteam flow.
  const msgText = ctx.callbackQuery.message?.text ?? "";
  const textMatch = msgText.match(/«([\s\S]+)»/);
  if (!textMatch) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.mcNotifyNoText);
  }
  const occ = await myOccurrencesToday(ctx.from.id);
  const o = occ?.[idx];
  if (!o) {
    await safeAnswer(ctx);
    return ctx.editMessageText(M.noMyMcToday);
  }
  await safeAnswer(ctx);
  await ctx.deleteMessage();
  return notifyOccurrence(ctx, o, textMatch[1]);
}));

async function renderCaught(ctx: Context, o: MCOccurrence) {
  const [regsRaw, catches, visitors] = await Promise.all([
    getRegistrations(),
    loadCatches(),
    getVisitorsMongo(),
  ]);
  const regs = asMCRegistrations(regsRaw);
  const nameById = new Map(
    visitors.filter((v) => v.telegramId).map((v) => [v.telegramId, v.name]),
  );
  const taken = activeRegs(regs, o.date, o.slot, o.mc.id);
  const earliestByTelegramId = new Map<string, string>();
  for (const c of catches) {
    if (!c.caughtAt.startsWith(o.date)) continue; // only count clicks from this occurrence's day
    const existing = earliestByTelegramId.get(c.telegramId);
    if (!existing || c.caughtAt < existing) earliestByTelegramId.set(c.telegramId, c.caughtAt);
  }
  const caught = taken
    .filter((r) => earliestByTelegramId.has(r.telegramId))
    .map((r) => ({
      name: nameById.get(r.telegramId) ?? M.mcAttendeeUnknown(r.telegramId),
      caughtAt: earliestByTelegramId.get(r.telegramId)!,
    }))
    .sort((a, b) => a.caughtAt.localeCompare(b.caughtAt));
  const lines = [M.caughtHeader(o.mc.title, o.slot)];
  if (caught.length === 0) lines.push(M.noCatches);
  else for (const c of caught) lines.push(`• ${c.name} — ${c.caughtAt}`);
  return ctx.reply(lines.join("\n"));
}

bot.command("caught", mongoGuarded(async (ctx) => {
  const occ = await myOccurrencesToday(ctx.from!.id);
  if (occ === null) return ctx.reply(M.notResponsible);
  if (occ.length === 0) return ctx.reply(M.noMyMcToday);
  if (occ.length === 1) return renderCaught(ctx, occ[0]);
  const kb = new InlineKeyboard();
  occ.forEach((o, i) => kb.text(`${o.mc.title} (${o.slot})`, `cn:${i}`).row());
  return ctx.reply(M.caughtChoose, { reply_markup: kb });
}));

bot.callbackQuery(/^cn:(\d+)$/, mongoGuarded(async (ctx) => {
  const idx = Number(ctx.match[1]);
  const occ = await myOccurrencesToday(ctx.from.id);
  const o = occ?.[idx];
  await safeAnswer(ctx);
  if (!o) return ctx.editMessageText(M.noMyMcToday);
  await ctx.deleteMessage();
  return renderCaught(ctx, o);
}));

// --- keyboard button handlers (must be before message:text catch-all) ---

bot.hears(BTN.masterclasses, mongoGuarded(handleMasterclasses));
bot.hears(BTN.schedule, handleSchedule);
bot.hears(BTN.myRegs, mongoGuarded(handleMyRegs));
bot.hears(BTN.teamRoster, mongoGuarded(handleTeamRoster));
bot.hears(BTN.teamMc, mongoGuarded(handleTeamMc));
// The hint-only buttons still check the role, so a revoked leader/responsible gets
// their keyboard refreshed instead of a hint for a command they can no longer run.
bot.hears(BTN.notifyTeam, async (ctx) =>
  (await myLedTeams(ctx.from!.id))
    ? ctx.reply(M.notifyTeamHint)
    : replyRoleRevoked(ctx, M.notLeader),
);
bot.hears(BTN.renameTeam, async (ctx) =>
  (await myLedTeams(ctx.from!.id))
    ? ctx.reply(M.renameTeamHint)
    : replyRoleRevoked(ctx, M.notLeader),
);
bot.hears(BTN.mcAttendees, mongoGuarded(handleMcAttendees));
bot.hears(BTN.mcNotify, async (ctx) =>
  (await getUserRoles(ctx.from!.id)).isResponsible
    ? ctx.reply(M.mcNotifyHint)
    : replyRoleRevoked(ctx, M.notResponsible),
);

// --- name search (must be after commands) ---

bot.on("message:text", async (ctx) => {
  const {
    sheet,
    visitor: meVisitor,
    asLeader: meLeader,
    asResponsible: meResponsible,
  } = await loadRoleContext(ctx.from.id);

  // Only visitors are searched here — leader/responsible linking is command-gated behind
  // /leader and /responsible, so a typed name can never offer someone else's role.
  const visitorMatches = meVisitor ? [] : searchByName(sheet.visitors, ctx.message.text);

  if (visitorMatches.length === 0) {
    if (meLeader.length > 0)
      return ctx.reply(M.leaderAlreadyLinked(meLeader[0].name, meLeader[0].team));
    if (meResponsible.length > 0) return ctx.reply(M.respAlreadyLinked(meResponsible[0].name));
    if (meVisitor) return ctx.reply(M.alreadyLinked(meVisitor.name));
    return ctx.reply(M.notFound);
  }

  const kb = new InlineKeyboard();
  if (visitorMatches.length === 1) {
    kb.text(visitorMatches[0].name, `link:${visitorMatches[0].rowIndex}`).row();
    return ctx.reply(M.confirmOne, { reply_markup: kb });
  }
  for (const v of visitorMatches) kb.text(v.name, `link:${v.rowIndex}`).row();
  return ctx.reply(M.chooseYourself, { reply_markup: kb });
});

// Scoped command menus are NOT rebuilt on cold start. Telegram stores them server-side
// permanently, and they are already updated incrementally whenever a role changes (see
// /leader, /addadmin, /removeadmin), so rebuilding cost a Sheets read plus one Telegram
// call per admin and leader on every new serverless instance — paid concurrently by
// every lambda a check-in rush spins up, delaying the webhook it was started to serve.
// Use /syncmenus if the menus ever need reconciling with the sheets by hand.
bot.command("syncmenus", async (ctx) => {
  const { admins } = await loadAdmins();
  if (!isAdmin(ctx.from?.id, admins)) return ctx.reply(M.notAdmin);
  const { leaders } = await loadLeaders();
  await initCommandMenus(bot, admins, leaders);
  return ctx.reply(M.menusSynced(admins.length, leaders.length));
});
