import { Keyboard } from "grammy";

export const BTN = {
  events: "📅 Події сьогодні",
  schedule: "🗓 Розклад",
  myEvents: "📋 Мої реєстрації",
  notifyTeam: "📢 Сповістити команду",
  renameTeam: "✏️ Перейменувати команду",
} as const;

export function visitorKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.events).text(BTN.schedule).row()
    .text(BTN.myEvents)
    .resized()
    .persistent();
}

export function leaderKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.events).text(BTN.schedule).row()
    .text(BTN.myEvents).row()
    .text(BTN.notifyTeam).row()
    .text(BTN.renameTeam)
    .resized()
    .persistent();
}
