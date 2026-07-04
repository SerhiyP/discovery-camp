const GENERAL_INFO =
  "Тут можна:\n" +
  "🎨 реєструватись на майстер-класи\n" +
  "🗓 дивитись розклад табору\n" +
  "📋 бачити свої реєстрації";

export const M = {
  generalInfo: GENERAL_INFO,
  welcome:
    "Вітаємо в Discovery Camp! 🏕\n\n" +
    `${GENERAL_INFO}\n\n` +
    "Щоб почати, відмітьтесь на реєстрації — напишіть своє прізвище та ім'я, так, як ви вказували їх у формі реєстрації.",
  alreadyLinked: (name: string) => `Ви вже відмічені як ${name} ✅`,
  askName: "Напишіть своє прізвище та ім'я — так, як у формі реєстрації.",
  chooseYourself: "Знайшли кілька збігів. Натисніть на своє ім'я 👇",
  confirmOne: "Це ви? Натисніть, щоб підтвердитись 👇",
  notFound:
    "Не знайшли вас у списку 😔 Спробуйте написати ім'я інакше (наприклад, лише прізвище) або зверніться до організаторів на вході.",
  rowTaken:
    "Цей учасник уже відмітився з іншого акаунта. Якщо це помилка — зверніться до організаторів.",
  checkedIn: (name: string, room?: string) =>
    `Готово, ${name}! Ви відмічені ✅${room ? `\nВаша кімната: ${room}` : ""}\nГарного табору! 🎉`,
  videoCaption: "Відеопривітання від вашого лідера команди 🎬",
  noMasterclassesToday: "Сьогодні майстер-класів немає.",
  mcDayTitle: "🎨 Майстер-класи сьогодні:",
  mcRegistered: (title: string, slot: string, place: string) =>
    `Ви зареєстровані на «${title}» (${slot}, ${place}) ✅`,
  mcUnregistered: (title: string, slot: string) =>
    `Реєстрацію на «${title}» (${slot}) скасовано.`,
  mcFull: "На жаль, місць більше немає 😔",
  mcAlready: "Ви вже зареєстровані на цей майстер-клас.",
  mcSlotTaken:
    "У цей час ви вже зареєстровані на інший майстер-клас. Спершу скасуйте ту реєстрацію.",
  mcReminder: (slot: string) =>
    `⏰ За годину — майстер-класи о ${slot}. Ви ще не записались, встигніть обрати:`,
  myRegsTitle: "Ваші реєстрації:",
  myRegsEmpty: "Ви поки не зареєстровані на жодний майстер-клас.",
  scheduleUnavailable: "Розклад тимчасово недоступний.",
  scheduleGridTitle: (dayLabel: string) => `📅 Розклад — ${dayLabel}`,
  scheduleGridLine: (slot: { time: string; activity: string; isCurrent: boolean }) =>
    `${slot.isCurrent ? "▶ " : ""}${slot.time} ${slot.activity}`,
  scheduleNotStarted: "Табір ще не розпочався.\nОсь розклад першого дня:",
  scheduleCampFinished: "Табір завершено.\nДякуємо, що були з нами! 🎉",
  mustCheckInFirst: "Спершу відмітьтесь: напишіть своє прізвище та ім'я.",

  // Role capabilities info (post-registration + /help)
  capabilitiesBase:
    "Ось що вам доступно:\n" +
    "🎨 Майстер-класи — реєстрація на майстер-класи\n" +
    "🗓 Розклад — розклад табору на сьогодні\n" +
    "📋 Мої реєстрації — ваші записи на майстер-класи",
  capabilitiesLeader:
    "👑 Як лідер команди:\n" +
    "📢 Сповістити команду — надіслати повідомлення своїй команді\n" +
    "✏️ Перейменувати команду — змінити назву команди",
  capabilitiesResponsible:
    "🎨 Як відповідальний за майстер-клас:\n" +
    "👥 Учасники МК — список учасників вашого майстер-класу\n" +
    "📣 Сповістити учасників МК — надіслати їм повідомлення",

  // /myid
  yourId: (id: number) => `Ваш Telegram ID: <code>${id}</code>`,

  // Leader check-in
  leaderPrompt:
    "Це вхід для лідерів команд. Напишіть своє прізвище та ім'я — так, як вас зареєстрував адміністратор.",
  leaderAlreadyLinked: (name: string, team: string) =>
    `Ви вже підключені як лідер команди «${team}» (${name}) ✅`,
  confirmLeader: (name: string, team: string) =>
    `Це ви — лідер команди «${team}»?\n${name}\n\nНатисніть, щоб підтвердитись 👇`,
  leaderCheckedIn: (name: string, team: string) =>
    `Готово, ${name}! Ви підключені як лідер команди «${team}» ✅`,
  leaderNotFound:
    "Не знайшли вас у списку лідерів 😔 Зверніться до адміністратора.",

  // Responsible check-in
  confirmResp: (name: string) =>
    `Це ви — відповідальний за майстер-клас?\n${name}\n\nНатисніть, щоб підтвердитись 👇`,
  respCheckedIn: (name: string, titles: string) =>
    `Готово, ${name}! Ви підключені як відповідальний за: ${titles} ✅`,
  respNotFound:
    "Не знайшли вас у списку відповідальних 😔 Зверніться до адміністратора.",

  // Leader commands
  notifyTeamNoText: "Використання: /notifyteam <текст повідомлення>",
  notifyTeamEmpty: "У вашій команді ще ніхто не підключився до бота.",
  notifyTeamSent: (count: number, teams: string) =>
    `Надіслано ${count} учасникам команд: ${teams} ✅`,
  renameTeamNoText: "Використання: /renameteam <нова назва>",
  renameTeamDone: (oldName: string, newName: string, count: number) =>
    `Команду «${oldName}» перейменовано на «${newName}» ✅ Оновлено ${count} учасників.`,
  chooseTeamToRename: (newName: string) => `Яку команду перейменувати на «${newName}»?`,
  videoUpdated: (team: string) => `Відео для команди «${team}» оновлено ✅`,
  videoMultiTeamHint: (teams: string) =>
    `Для якої команди це відео?\nВаші команди: ${teams}\n\nДодайте назву команди як підпис до відео і надішліть ще раз.`,

  // Admin commands
  addLeaderUsage: "Використання: /addleader <Команда> <Прізвище та ім'я>",
  leaderAdded: (name: string, team: string) => `Лідера ${name} додано до команди «${team}» ✅`,
  leaderAddedFull: (team: string) =>
    `У команди «${team}» вже 3 лідери — більше додати не можна.`,
  leaderAddedDuplicate: (name: string, team: string) =>
    `${name} вже є лідером команди «${team}».`,
  removeLeaderUsage: "Використання: /removeleader <Команда> <Прізвище та ім'я>",
  leaderRemoved: (name: string, team: string) =>
    `Лідера ${name} видалено з команди «${team}» ✅`,
  leaderNotFoundAdmin: (name: string, team: string) =>
    `Лідера ${name} у команді «${team}» не знайдено.`,
  noLeaders: "Лідерів ще немає.",
  leadersListTitle: "Список лідерів:",
  leaderListLine: (team: string, name: string, linked: boolean) =>
    `• [${team}] ${name}${linked ? " ✅" : " (не підключений)"}`,

  // Responsible admin commands
  addRespUsage: "Використання: /addresp <ID майстер-класу> <Прізвище та ім'я>",
  mcNotFoundAdmin: (mcId: string) =>
    `Майстер-клас з ID ${mcId} не знайдено у каталозі.`,
  respAdded: (name: string, title: string) =>
    `${name} — відповідальний за «${title}» ✅`,
  respDuplicate: (name: string, title: string) =>
    `${name} вже відповідальний за «${title}».`,
  respRemoved: (name: string, title: string) =>
    `${name} більше не відповідальний за «${title}» ✅`,
  mcCatalogUnavailable: "Каталог майстер-класів недоступний.",
  mcSyncTitle: "Синхронізація відповідальних:",
  mcSyncAdded: (name: string, title: string) => `✅ ${name} — ${title}`,
  mcSyncDuplicate: (name: string, title: string) => `⚪ ${name} — ${title} (вже є)`,
  mcSyncSummary: (added: number, existing: number) =>
    `Додано: ${added}, вже було: ${existing}.`,
  noResponsiblePersons: "Відповідальних ще немає.",
  delRespPickerTitle: "Кого видалити з відповідальних?",
  confirmDelResp: (name: string, title: string) => `Видалити ${name} з «${title}»?`,
  delRespGone: "Цей запис уже видалено.",

  // Superadmin commands
  notSuperAdmin: "Ця команда доступна лише суперадміну.",
  notAdmin: "Ця команда доступна лише адміністраторам.",
  notLeader: "Ця команда доступна лише лідерам команд.",
  addAdminUsage: "Використання: /addadmin <TelegramID> <Ім'я>",
  adminAdded: (name: string, id: string) => `Адміна ${name} (${id}) додано ✅`,
  adminAddedDuplicate: (id: string) => `Адмін з ID ${id} вже існує.`,
  removeAdminUsage: "Використання: /removeadmin <TelegramID>",
  adminRemoved: (id: string) => `Адміна ${id} видалено ✅`,
  adminNotFound: (id: string) => `Адміна з ID ${id} не знайдено.`,
  noAdmins: "Адмінів ще немає.",
  adminsListTitle: "Список адмінів:",
  adminListLine: (name: string, id: string) => `• ${name} (${id})`,

  // Leader keyboard hints
  notifyTeamHint: "Напишіть команду з текстом:\n/notifyteam <ваше повідомлення>",
  renameTeamHint: "Напишіть команду з новою назвою:\n/renameteam <нова назва>",

  // Responsible tools
  notResponsible: "Ця функція доступна лише відповідальним за майстер-класи.",
  noMyMcToday: "Сьогодні ваших майстер-класів немає.",
  mcAttendeesHeader: (title: string, slot: string, place: string, taken: number, capacity: number) =>
    `🎨 ${title} — ${slot}, ${place} (${taken}${capacity > 0 ? `/${capacity}` : ""}):`,
  mcNoAttendees: "— поки нікого",
  mcNotifyNoText: "Використання: /notifymc <текст повідомлення>",
  mcNotifyHint: "Напишіть команду з текстом:\n/notifymc <ваше повідомлення>",
  mcNotifyChoose: (text: string) =>
    `Учасникам якого майстер-класу надіслати «${text}»?`,
  mcNotifySent: (sent: number, total: number, title: string, slot: string) =>
    `Надіслано ${sent}/${total} учасникам «${title}» (${slot}) ✅`,
};

/** Composes the post-registration / `/help` capability message from a person's full
 *  current role set — mirrors how `roleKeyboard()` composes the reply keyboard. Takes
 *  the same shape `getUserRoles()` returns so callers can pass it through directly. */
export function roleCapabilitiesText(roles: { isLeader?: boolean; isResponsible?: boolean }): string {
  const parts = [M.capabilitiesBase];
  if (roles.isLeader) parts.push(M.capabilitiesLeader);
  if (roles.isResponsible) parts.push(M.capabilitiesResponsible);
  return parts.join("\n\n");
}
