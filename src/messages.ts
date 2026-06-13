export const M = {
  welcome:
    "Вітаємо в Discovery Camp! 🏕\n\nЩоб відмітитись на реєстрації, напишіть своє прізвище та ім'я — так, як ви вказували їх у формі реєстрації.",
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
  noEventsToday: "На сьогодні подій немає.",
  eventsToday: "Події на сьогодні:",
  scheduleTitle: "Розклад подій:",
  scheduleGridTitle: (dayLabel: string) => `📅 Розклад — ${dayLabel}`,
  scheduleGridLine: (slot: { time: string; activity: string; isCurrent: boolean }) =>
    `${slot.isCurrent ? "▶ " : ""}${slot.time} ${slot.activity}`,
  registered: (title: string) => `Ви зареєстровані на «${title}» ✅`,
  unregistered: (title: string) => `Реєстрацію на «${title}» скасовано.`,
  eventFull: "На жаль, місць більше немає 😔",
  alreadyRegistered: "Ви вже зареєстровані на цю подію.",
  myEventsTitle: "Ваші реєстрації:",
  myEventsEmpty: "Ви поки не зареєстровані на жодну подію. Подивіться /events",
  mustCheckInFirst: "Спершу відмітьтесь: напишіть своє прізвище та ім'я.",
  morningDigest: "Доброго ранку! ☀️ Сьогодні в таборі:",
  registerButton: "Зареєструватися",
  unregisterButton: "Скасувати реєстрацію",
  spotsLeft: (n: number) => `вільних місць: ${n}`,

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

};
