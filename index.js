import http from 'http';
import { startBot } from './src/app.js';

let latestQrUrl = null;
let botState = 'initializing';

export function setLatestQr(qr) {
  latestQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(qr)}`;
  botState = 'qr_ready';
}

export function clearLatestQr() {
  latestQrUrl = null;
  botState = 'ready';
}

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  if (botState === 'qr_ready' && latestQrUrl) {
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Scan WhatsApp QR Code</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="refresh" content="5">
          <style>
            body { font-family: system-ui, sans-serif; text-align: center; padding: 40px 20px; background: #0f172a; color: #fff; }
            .card { background: #1e293b; display: inline-block; padding: 30px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
            img { border: 8px solid #fff; border-radius: 12px; margin-top: 15px; }
            h1 { font-size: 22px; color: #38bdf8; margin-bottom: 10px; }
            p { font-size: 15px; color: #94a3b8; }
            .badge { background: #0284c7; color: #fff; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="card">
            <span class="badge">جاهز للمسح</span>
            <h1>افتح الواتساب واعمل مسح للـ QR Code</h1>
            <p>افتح الواتساب من موبايلك > الأجهزة المرتبطة (Linked Devices) > ربط جهاز</p>
            <img src="${latestQrUrl}" alt="WhatsApp QR Code" />
          </div>
        </body>
      </html>
    `);
    return;
  }

  if (botState === 'ready') {
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Nova Bot - Ready</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: system-ui, sans-serif; text-align: center; padding: 50px 20px; background: #0f172a; color: #fff; }
            .card { background: #1e293b; display: inline-block; padding: 40px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
            h1 { font-size: 24px; color: #4ade80; margin-bottom: 10px; }
            p { font-size: 16px; color: #94a3b8; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>✅ WhatsApp Nova Bot is Active & Ready! 🚀</h1>
            <p>البوت متصل بالواتساب وشغال أونلاين بنجاح 100%</p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  // Initializing state
  res.end(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Nova Bot - Loading...</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="refresh" content="4">
        <style>
          body { font-family: system-ui, sans-serif; text-align: center; padding: 50px 20px; background: #0f172a; color: #fff; }
          .card { background: #1e293b; display: inline-block; padding: 40px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          .spinner { border: 4px solid rgba(255,255,255,0.1); width: 40px; height: 40px; border-radius: 50%; border-left-color: #38bdf8; animation: spin 1s linear infinite; margin: 20px auto; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          h1 { font-size: 22px; color: #38bdf8; margin-bottom: 10px; }
          p { font-size: 15px; color: #94a3b8; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="spinner"></div>
          <h1>⏳ جاري تحميل البوت وتجهيز الـ QR Code...</h1>
          <p>سيرفر Render يقوم الآن بفتح المتصفح وتحميل الواتساب (يستغرق من 20 إلى 40 ثانية).</p>
          <p style="font-size:13px; color:#64748b;">هذه الصفحة تتحدث تلقائياً كل 4 ثوانٍ وسوف يظهر الـ QR كود فور جهوزيته...</p>
        </div>
      </body>
    </html>
  `);
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
