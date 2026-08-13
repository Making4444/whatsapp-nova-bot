import { startBot } from './src/app.js';

startBot().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
