import http from 'http';
import { startBot } from './src/app.js';

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('WhatsApp Nova Bot is running 🚀');
}).listen(PORT, () => {
  console.log(`[HTTP] Health check server listening on port ${PORT}`);
});

startBot().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
