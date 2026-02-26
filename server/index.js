import { query } from './config/database.js';
// Periodic cleanup of expired OAuth states
setInterval(async () => {
  try {
    await query(`DELETE FROM oauth_state_store WHERE expires_at < NOW()`);
    // Optionally log cleanup
    // console.log('[oauthStateStore] Cleaned up expired states');
  } catch (err) {
    console.error('[oauthStateStore] Cleanup error:', err);
  }
}, 60 * 60 * 1000); // every hour
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/auth.js';
import oauthRoutes from './routes/oauth.js';
import threadsRoutes from './routes/threads.js';
import internalThreadsRoutes from './routes/internalThreads.js';
import accountsRoutes from './routes/accounts.js';
import postsRoutes from './routes/posts.js';
import dashboardRoutes from './routes/dashboard.js';
import scheduleRoutes from './routes/schedule.js';
import analyticsRoutes from './routes/analytics.js';
import aiRoutes from './routes/ai.js';
import mediaRoutes from './routes/media.js';
import creditsRoutes from './routes/credits.js';

import { requirePlatformLogin } from './middleware/requirePlatformLogin.js';
import { resolveTeamContextMiddleware } from './middleware/resolveTeamContext.js';
import { ensureSchema } from './config/schema.js';
import { logger } from './utils/logger.js';
import { startScheduledPostWorker, stopScheduledPostWorker } from './services/scheduledPostWorker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Always load server/.env even when process is started from monorepo root.
dotenv.config({ path: path.resolve(__dirname, '.env') });
const app = express();

const PORT = Number.parseInt(process.env.PORT || '3006', 10);

const allowedOrigins = [
  'https://suitegenie.in',
  'https://social.suitegenie.in',
  'https://apisocial.suitegenie.in',
  'http://localhost:5173',
  'http://localhost:5176',
  'http://localhost:3000',
  'http://localhost:3006',
];

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: [
          "'self'",
          'https://www.googleapis.com',
          'https://graph.facebook.com',
          'https://api.instagram.com',
          'https://graph.threads.net',
          'https://www.threads.net',
        ],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'https:', 'data:'],
      },
    },
  })
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      try {
        const hostname = new URL(origin).hostname;
        if (hostname === 'suitegenie.in' || hostname.endsWith('.suitegenie.in')) {
          return callback(null, true);
        }
      } catch {
        // ignore invalid origin
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'x-team-id'],
  })
);

app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'OK', service: 'Meta Genie' });
});

app.get('/api/csrf-token', (_req, res) => {
  res.json({ csrfToken: 'dummy-csrf-token' });
});


app.use('/auth', authRoutes);
app.use('/api/oauth', oauthRoutes);
app.use('/api/threads', threadsRoutes);
app.use('/api/internal/threads', internalThreadsRoutes);

app.use('/api', requirePlatformLogin, resolveTeamContextMiddleware);
app.use('/api/accounts', accountsRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/credits', creditsRoutes);

app.get('/', (_req, res) => {
  res.json({
    service: 'Meta Genie API',
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

app.use((error, req, res, _next) => {
  logger.error('Unhandled server error', {
    path: req.originalUrl,
    message: error.message,
  });

  if (error.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: error.message });
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Uploaded file is too large' });
  }

  return res.status(500).json({ error: error.message || 'Internal server error' });
});

const start = async () => {
  await ensureSchema();
  startScheduledPostWorker();

  app.listen(PORT, () => {
    logger.info(`Meta Genie server running on port ${PORT}`);
  });
};

start().catch((error) => {
  logger.error('Failed to start server', { message: error.message });
  stopScheduledPostWorker();
  process.exit(1);
});

process.on('SIGINT', () => {
  stopScheduledPostWorker();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopScheduledPostWorker();
  process.exit(0);
});
