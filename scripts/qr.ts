// Generates the poster QR code: scanning opens the bot with /start checkin.
// Usage: BOT_USERNAME=DiscoveryCampBot npm run qr
import QRCode from "qrcode";

const username = process.env.BOT_USERNAME;
if (!username) {
  console.error("Set BOT_USERNAME (without @) in .env or inline");
  process.exit(1);
}

const url = `https://t.me/${username}?start=checkin`;
const out = "checkin-qr.png";

QRCode.toFile(out, url, { width: 1024, margin: 2 }).then(() => {
  console.log(`QR for ${url} saved to ${out}`);
});
