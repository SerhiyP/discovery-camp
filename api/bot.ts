import { webhookCallback } from "grammy";
import { bot } from "../src/bot";

// grammY's webhook timeout defaults to 10s with `onTimeout: "throw"`, which is what
// caused the 2026-08-03 and 2026-08-04 duplicate-broadcast storms: /broadcast to 127
// people takes ~11-20s (9 chunks of 15, 1s pause between), grammY rejected at 10s,
// Vercel returned 500, and Telegram redelivered the same update — re-running the
// broadcast from the top every ~10s. vercel.json's `maxDuration: 60` never applied,
// because grammY gave up first.
//
// 50s keeps the ceiling under `maxDuration: 60` (a lambda Vercel kills is a 504, which
// Telegram also redelivers), and "return" answers 200 instead of throwing, so a
// genuinely wedged handler drops one update instead of looping forever. Slow work is
// not failed work — retrying it is what duplicates the side effects.
export default webhookCallback(bot, "https", {
  secretToken: process.env.WEBHOOK_SECRET,
  timeoutMilliseconds: 50_000,
  onTimeout: "return",
});
