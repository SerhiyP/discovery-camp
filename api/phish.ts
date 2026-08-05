import type { VercelRequest, VercelResponse } from "@vercel/node";
import { M } from "../src/messages";
import { logScan } from "../src/phishing";

// Direct-HTTP phishing test. The QR poster encodes this URL (not a t.me deep
// link), so scanning opens the reveal page instantly in the browser — a much
// harder test than the Telegram path, and the only way to test "scanned a random
// QR" at all. There is no telegramId here by design; we just count scans.
//
// Counting happens on the POST fired by the page's inline script, NOT on the GET:
// QR-scanner apps and messenger link-previewers prefetch the URL server-side but
// don't run JavaScript, so counting the GET would tally robots. The reveal itself
// must never depend on the write — the page renders even if Mongo is down.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "POST") {
    try {
      await logScan();
    } catch (err) {
      // Best-effort, like logCatch: a Mongo hiccup must not turn the beacon into an
      // error the browser surfaces. The reveal is already on screen regardless.
      console.error("phishing: logScan failed", err);
    }
    return res.status(204).end();
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(page(M.phishCaughtQr));
}

function page(message: string): string {
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>🎣</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    min-height: 100%; padding: 24px; box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1720; color: #f5f7fa;
  }
  .card {
    max-width: 34rem; text-align: center; line-height: 1.5;
    font-size: 1.25rem;
  }
</style>
</head>
<body>
  <main class="card">${escapeHtml(message)}</main>
  <script>
    // Count only real browsers that render the page — robots don't run this.
    try { fetch("/api/phish", { method: "POST", keepalive: true }); } catch (e) {}
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
