import { webhookCallback } from "grammy";
import { bot } from "../src/bot";

export default webhookCallback(bot, "https", {
  secretToken: process.env.WEBHOOK_SECRET,
});
