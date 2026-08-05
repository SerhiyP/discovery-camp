// Generates the poster QR code: scanning opens the bot with /start checkin.
// Usage: BOT_USERNAME=DiscoveryCampBot npm run qr
// Any other link (e.g. the phishing-training bot) can be passed explicitly:
//   npm run qr -- https://t.me/OtherBot?start=caught phish-qr.png
import QRCode from "qrcode";
import "dotenv/config";

const [argUrl, argOut] = process.argv.slice(2);

if (!argUrl && !process.env.BOT_USERNAME) {
  console.error("Pass a URL as an argument, or set BOT_USERNAME (without @) in .env");
  process.exit(1);
}

const url = argUrl ?? `https://t.me/${process.env.BOT_USERNAME}?start=checkin`;
const out = argOut ?? (argUrl ? "qr.png" : "checkin-qr.png");

QRCode.toFile(out, url, { width: 1024, margin: 2 }).then(() => {
  console.log(`QR for ${url} saved to ${out}`);
});
