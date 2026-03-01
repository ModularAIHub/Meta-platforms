import http from 'http';
import dotenv from 'dotenv';
import { startScheduledPostWorker, stopScheduledPostWorker } from './services/scheduledPostWorker.js';

dotenv.config();

// Minimal health server so Render free web service tier keeps this process alive.
const PORT = process.env.PORT || 3099;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'social-genie-worker', ts: Date.now() }));
}).listen(PORT, () => console.log(`[Social Worker] Health server listening on ${PORT}`));

const shutdown = (signal) => {
  console.log(`[Social Worker] Shutdown signal received: ${signal}`);
  stopScheduledPostWorker();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startScheduledPostWorker();
console.log('[Social Worker] Scheduled post worker started');
