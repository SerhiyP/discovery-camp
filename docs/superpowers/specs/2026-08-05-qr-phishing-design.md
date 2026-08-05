# QR-scan phishing test (direct HTTP) — Design

**Date:** 2026-08-05
**Status:** Approved, ready for implementation

## Problem

The phishing-awareness training currently has one attack channel: a Telegram deep
link (`t.me/DiscoveryHelpBot?start=caught`) baked into a QR code. Scanning it is a
soft test — the browser offers "open in Telegram?", the channel logo looks safe,
and only after several hops does the victim see the reveal. It also can't test the
most basic QR attack: *scanning a random QR that silently opens an attacker's web
page*.

We want a second, independent channel: a QR that opens a plain web page directly in
the browser, reveals the gotcha, and counts the scan. Because there is no Telegram
hop there is no `telegramId` — the count is deliberately anonymous.

This is **additive**. The Telegram deep link and its per-masterclass `/caught`
reveal are unchanged.

## Two channels, side by side

| | Telegram deep link (existing) | QR direct-HTTP (new) |
|---|---|---|
| Trigger | `t.me/…?start=caught` → `/start caught` | `GET /api/phish` |
| Identity | `telegramId` (who fell for it) | anonymous (count only) |
| Reveal message | `M.phishCaught` | `M.phishCaughtQr` (new) |
| Storage | `phishCatches` collection | `phishScans` collection (new) |
| `/stats` line | `Спіймані (TG): …` | `QR-сканувань: …` |

## Components

### 1. `api/phish.ts` — public Vercel serverless route

No secret guard (anyone scanning must reach it).

- `GET /api/phish` → returns a small self-contained HTML page (mobile viewport,
  inline CSS) showing the reveal text `M.phishCaughtQr`. **The reveal is the whole
  point, so this always renders — even if Mongo is unset or down.**
- The page carries one inline `<script>` that fires `fetch('/api/phish', {method:
  'POST'})` on load.
- `POST /api/phish` → best-effort scan increment, returns `204`. Wrapped in
  try/catch (like the existing `logCatch`); a Mongo hiccup never breaks the page.

**Why count on the JS beacon, not the GET.** QR-scanner apps and iMessage /
Telegram / WhatsApp link-previewers *prefetch* the URL server-side but **do not run
JavaScript**. Counting on the GET would inflate the number with these robots.
Counting on the POST-from-script means only a real browser that actually rendered
the page — i.e. a human who scanned — is tallied. Not bulletproof (a JS-running bot
would still count), but by far the cleanest option for a camp-scale test.

### 2. `phishScans` Mongo collection

One document per scan: `{ scannedAt: nowStamp() }`.

- **Not** reusing `phishCatches`: that collection is keyed by `telegramId` and feeds
  the per-masterclass `/caught` grouping — anonymous scans have no ID and would
  corrupt it.
- One-doc-per-scan (vs. a single `$inc` counter) is trivially cheap at camp volume
  and yields a free per-day breakdown, matching how TG catches are shown.

Add `phishScans: "phishScans"` to `COLLECTIONS` in `src/mongo.ts`.

### 3. `src/phishing.ts` — scan helpers

- `logScan(): Promise<void>` — insert `{ scannedAt: nowStamp() }` into `phishScans`.
- `loadScans(): Promise<PhishScan[]>` — read all, map to `{ scannedAt }`.

Mirrors the existing `logCatch` / `loadCatches` shape.

### 4. `/stats` integration (`src/bot.ts`)

- Add `loadScans()` to the command's `Promise.all`.
- Extend `formatPhishStats` (or add a sibling block) so the `🎣 Фішинг:` section
  shows the QR channel under the TG lines:

  ```
  🎣 Фішинг:
  Спіймані (TG): 12 (18 переходів)
  QR-сканувань: 34
    2026-08-05: 34
  ```

- New strings in `src/messages.ts`:
  - `phishCaughtQr` — reveal shown on the HTML page.
  - `statsScans(n)` / `statsScanDayLine(date, n)` — stats lines.

Existing TG-catch lines and strings are untouched.

### 5. QR asset

Regenerate `phish-qr.png` to encode `https://discovery-camp.vercel.app/api/phish`
(instead of the `t.me` link) using the already-generalized `scripts/qr.ts`:

```bash
npm run qr -- "https://discovery-camp.vercel.app/api/phish" phish-qr.png
```

## Draft reveal copy (tweakable)

> 🎣 Ви попались! Ви відсканували фішинговий QR-код. Ніколи не скануйте незнайомі
> QR-коди — вони можуть вести на шахрайські сайти. Обговоримо це на майстер-класі
> по захисту телефона.

## Error handling & edge cases

- **Mongo unset/down:** page renders; count is silently skipped. Same rule as the
  existing "the reveal must never depend on the write" note for `logCatch`.
- **Robots that run JS:** vanishingly rare; accepted as noise. Count reads as a
  near-lower-bound of real human scans.
- **No global `bot.catch` concern:** this route is outside the grammY webhook, a
  plain Vercel handler, so its own try/catch fully contains failures.

## Out of scope

- No per-QR / per-location campaign labels (one QR is enough).
- No attempt to identify the scanner (inherent to dropping Telegram).
- No change to the Telegram `/start=caught` path or the `/caught` reveal.
