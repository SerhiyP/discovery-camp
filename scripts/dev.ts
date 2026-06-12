import "dotenv/config";
import { bot } from "../src/bot";

bot.catch((err) => {
  const { message, code } = err.error as { message?: string; code?: number };
  console.error(`[error] ${code ?? ""} ${message ?? err.error}`);
});

console.log("Starting bot in long-polling mode…");
bot.start();
