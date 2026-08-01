import { Keyboard } from "grammy";

export const BTN = {
  masterclasses: "🎨 Майстер-класи",
  schedule: "🗓 Розклад",
  myRegs: "📋 Мої реєстрації",
  teamRoster: "👥 Моя команда",
  teamMc: "🎨 МК команди",
  notifyTeam: "📢 Сповістити команду",
  renameTeam: "✏️ Перейменувати команду",
  mcAttendees: "👥 Учасники МК",
  mcNotify: "📣 Сповістити учасників МК",
} as const;

/** Reply keyboard composed from roles: base visitor rows, plus leader and/or
 *  responsible rows — a person can be both leader and responsible. */
export function roleKeyboard(
  opts: { leader?: boolean; responsible?: boolean } = {},
): Keyboard {
  const kb = new Keyboard()
    .text(BTN.masterclasses).text(BTN.schedule).row()
    .text(BTN.myRegs);
  if (opts.leader) {
    kb.row().text(BTN.teamRoster).text(BTN.teamMc);
    kb.row().text(BTN.notifyTeam).row().text(BTN.renameTeam);
  }
  if (opts.responsible) {
    kb.row().text(BTN.mcAttendees).row().text(BTN.mcNotify);
  }
  return kb.resized().persistent();
}
