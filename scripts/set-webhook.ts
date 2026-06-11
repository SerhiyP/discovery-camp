// Registers the Vercel deployment as the bot's webhook.
// Usage: npm run set-webhook (needs BOT_TOKEN, PUBLIC_URL, WEBHOOK_SECRET)
const token = process.env.BOT_TOKEN;
const publicUrl = process.env.PUBLIC_URL;
const secret = process.env.WEBHOOK_SECRET;

if (!token || !publicUrl) {
  console.error("Set BOT_TOKEN and PUBLIC_URL");
  process.exit(1);
}

const url = `${publicUrl.replace(/\/$/, "")}/api/bot`;

fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: secret || undefined,
    drop_pending_updates: true,
  }),
})
  .then((r) => r.json())
  .then((data) => console.log(JSON.stringify(data, null, 2)));
