import http from 'http';
import { startBot } from './src/app.js';

let latestQrUrl = null;

export function setLatestQr(qr) {
  latestQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(qr)}`;
}

export function clearLatestQr() {
  latestQrUrl = null;
}

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  if (latestQrUrl) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Scan WhatsApp QR Code</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: system-ui, sans-serif; text-align: center; padding: 40px 20px; background: #0f172a; color: #fff; }
            .card { background: #1e293b; display: inline-block; padding: 30px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
            img { border: 8px solid #fff; border-radius: 12px; margin-top: 15px; }
            h1 { font-size: 22px; color: #38bdf8; margin-bottom: 10px; }
            p { font-size: 15px; color: #94a3b8; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Scan QR Code to Connect WhatsApp Bot</h1>
            <p>Scan this QR code from WhatsApp on your phone (Linked Devices)</p>
            <img src="${latestQrUrl}" alt="WhatsApp QR Code" />
          </div>
        </body>
      </html>
    `);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('WhatsApp Nova Bot is active and running 🚀');
}).listen(PORT, () => {
  console.log(`[HTTP] Health check server listening on port ${PORT}`);
});

startBot({
  onQr: (qr) => setLatestQr(qr),
  onReady: () => clearLatestQr(),
}).catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
