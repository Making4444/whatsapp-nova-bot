import http from 'http';
import { startBot } from './src/app.js';

let isConnected = false;

export function clearLatestQr() {
  isConnected = true;
}

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  if (isConnected) {
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>WhatsApp Nova Bot - Connected</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: system-ui, sans-serif; text-align: center; padding: 60px 20px; background: #0f172a; color: #fff; }
            .card { background: #1e293b; display: inline-block; padding: 40px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 400px; width: 100%; }
            .status { display: inline-flex; align-items: center; gap: 8px; background: #166534; color: #4ade80; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 14px; margin-bottom: 20px; }
            .dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; display: inline-block; }
            h1 { font-size: 22px; color: #f8fafc; margin-bottom: 10px; }
            p { font-size: 15px; color: #94a3b8; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="status"><span class="dot"></span> متصل بالواتساب أونلاين</div>
            <h1>WhatsApp Nova Bot</h1>
            <p>الكود متصل بالواتساب وشغال بنجاح 100% 🚀</p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  res.end(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>WhatsApp Nova Bot - Connecting</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: system-ui, sans-serif; text-align: center; padding: 60px 20px; background: #0f172a; color: #fff; }
          .card { background: #1e293b; display: inline-block; padding: 40px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 400px; width: 100%; }
          .status { display: inline-flex; align-items: center; gap: 8px; background: #854d0e; color: #facc15; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 14px; margin-bottom: 20px; }
          .dot { width: 10px; height: 10px; background: #eab308; border-radius: 50%; display: inline-block; }
          h1 { font-size: 22px; color: #f8fafc; margin-bottom: 10px; }
          p { font-size: 15px; color: #94a3b8; line-height: 1.5; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="status"><span class="dot"></span> جاري الاتصال...</div>
          <h1>WhatsApp Nova Bot</h1>
          <p>جاري الاتصال بسيرفرات الواتساب وتأكيد الجلسة المسجلة...</p>
        </div>
      </body>
    </html>
  `);
}).listen(PORT, () => {
  console.log(`[HTTP] Health check server listening on port ${PORT}`);
});

startBot({
  onReady: () => clearLatestQr(),
}).catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
