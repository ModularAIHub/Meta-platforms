import { query } from './config/database.js';

// Periodic cleanup of expired OAuth states (every hour)
setInterval(async () => {
  try {
    await query(`DELETE FROM oauth_state_store WHERE expires_at < NOW()`);
  } catch (err) {
    console.error('[oauthStateStore] Cleanup error:', err);
  }
}, 60 * 60 * 1000);

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
import crossPostStatusRoutes from './routes/crossPostStatus.js';
import cleanupRoutes from './routes/cleanup.js';

import { requirePlatformLogin } from './middleware/requirePlatformLogin.js';
import { resolveTeamContextMiddleware } from './middleware/resolveTeamContext.js';
import { ensureSchema } from './config/schema.js';
import { logger } from './utils/logger.js';
import { startScheduledPostWorker, stopScheduledPostWorker, runSchedulerTick } from './services/scheduledPostWorker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3006', 10);
const READINESS_CHECK_INTERVAL_MS = Number.parseInt(process.env.READINESS_CHECK_INTERVAL_MS || '30000', 10);
const metaRuntimeState = {
  database: {
    ok: false,
    lastCheckedAt: null,
    error: 'Database readiness not checked yet',
  },
  schemaReady: false,
  schemaError: 'Schema readiness not checked yet',
  scheduledWorkerStarted: false,
};

const allowedOrigins = [
  'https://suitegenie.in',
  'https://tweet.suitegenie.in',
  'https://linkedin.suitegenie.in',
  'https://linkedin.suitgenie.in',
  'https://meta.suitegenie.in',
  'https://api.suitegenie.in',
  'https://tweetapi.suitegenie.in',
  'https://apilinkedin.suitegenie.in',
  'https://metaapi.suitegenie.in',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:3000',
  'http://localhost:3002',
  'http://localhost:3004',
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
        if (hostname === 'suitgenie.in' || hostname.endsWith('.suitgenie.in')) {
          return callback(null, true);
        }
        if (process.env.ALLOW_VERCEL_PREVIEWS === 'true' && hostname.endsWith('.vercel.app')) {
          return callback(null, true);
        }
      } catch {
        // ignore invalid origin
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Cookie',
      'X-CSRF-Token',
      'x-csrf-token',
      'X-Selected-Account-Id',
      'x-selected-account-id',
      'X-Team-Id',
      'x-team-id',
      'X-Requested-With',
    ],
  })
);

app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const setMetaDatabaseReady = () => {
  metaRuntimeState.database.ok = true;
  metaRuntimeState.database.lastCheckedAt = new Date().toISOString();
  metaRuntimeState.database.error = null;
};

const setMetaDatabaseNotReady = (error) => {
  metaRuntimeState.database.ok = false;
  metaRuntimeState.database.lastCheckedAt = new Date().toISOString();
  metaRuntimeState.database.error = error?.message || String(error || 'Unknown database error');
};

const refreshMetaDatabaseReadiness = async () => {
  try {
    await query('SELECT 1');
    setMetaDatabaseReady();
    return true;
  } catch (error) {
    setMetaDatabaseNotReady(error);
    return false;
  }
};

const markMetaSchemaReady = () => {
  metaRuntimeState.schemaReady = true;
  metaRuntimeState.schemaError = null;
};

const markMetaSchemaNotReady = (error) => {
  metaRuntimeState.schemaReady = false;
  metaRuntimeState.schemaError = error?.message || String(error || 'Unknown schema error');
};

const maybeEnsureMetaSchemaAndWorker = async () => {
  if (!metaRuntimeState.database.ok) {
    logger.warn('Meta Genie schema/worker startup skipped because database is not ready', {
      database: metaRuntimeState.database,
    });
    return;
  }

  if (!metaRuntimeState.schemaReady) {
    await ensureSchema();
    markMetaSchemaReady();
    logger.info('Meta Genie schema ready');
  }

  if (!metaRuntimeState.scheduledWorkerStarted) {
    startScheduledPostWorker();
    metaRuntimeState.scheduledWorkerStarted = true;
  }
};

const getMetaHealthPayload = () => {
  const ready = metaRuntimeState.database.ok && metaRuntimeState.schemaReady;
  return {
    status: ready ? 'OK' : 'DEGRADED',
    live: true,
    ready,
    service: 'Meta Genie',
    timestamp: new Date().toISOString(),
    checks: {
      database: { ...metaRuntimeState.database },
      schema: {
        ready: metaRuntimeState.schemaReady,
        error: metaRuntimeState.schemaError,
      },
      scheduledWorker: {
        started: metaRuntimeState.scheduledWorkerStarted,
      },
    },
  };
};

const startMetaReadinessLoop = () => {
  const intervalMs =
    Number.isFinite(READINESS_CHECK_INTERVAL_MS) && READINESS_CHECK_INTERVAL_MS > 0
      ? READINESS_CHECK_INTERVAL_MS
      : 30000;

  const timer = setInterval(async () => {
    await refreshMetaDatabaseReadiness();
    try {
      await maybeEnsureMetaSchemaAndWorker();
    } catch (error) {
      markMetaSchemaNotReady(error);
      logger.error('Meta Genie schema migration failed — server is running but scheduled posts may not work', {
        message: error.message,
      });
    }
  }, intervalMs);

  timer.unref?.();
};

app.get('/health', (_req, res) => {
  const payload = getMetaHealthPayload();
  res.status(200).json(payload);
});

app.get('/ready', (_req, res) => {
  const payload = getMetaHealthPayload();
  res.status(payload.ready ? 200 : 503).json(payload);
});

app.get('/api/csrf-token', (_req, res) => {
  res.json({ csrfToken: 'dummy-csrf-token' });
});

app.use('/auth', authRoutes);
app.use('/api/oauth', oauthRoutes);
app.use('/api/threads', threadsRoutes);
app.use('/api/internal/threads', internalThreadsRoutes);
app.use('/api/cleanup', cleanupRoutes);

// Vercel Cron trigger for the Meta Genie post scheduler.
// Called every minute by Vercel (see server/vercel.json). Auth via CRON_SECRET.
app.post('/api/cron/scheduler', async (req, res) => {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  const authHeader = req.headers['authorization'] || '';
  const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (authHeader || req.query.secret || '');
  if (!cronSecret || providedToken !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await runSchedulerTick();
    return res.json({ ok: true });
  } catch (error) {
    logger.error('[MetaSchedulerCron] Tick failed', { message: error?.message });
    return res.status(500).json({ ok: false, error: error?.message || 'unknown_error' });
  }
});

app.use('/api', requirePlatformLogin, resolveTeamContextMiddleware);
app.use('/api/accounts', accountsRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/cross-post', crossPostStatusRoutes);

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
  // START LISTENING IMMEDIATELY — don't block on schema migrations.
  // Cold starts on Render/Railway used to wait for ensureSchema() before
  // accepting any traffic, causing the first request to time out.
  app.listen(PORT, () => {
    logger.info(`Meta Genie server running on port ${PORT}`);
  });

  await refreshMetaDatabaseReadiness();
  try {
    await maybeEnsureMetaSchemaAndWorker();
  } catch (error) {
    markMetaSchemaNotReady(error);
    logger.error('Meta Genie schema migration failed — server is running but scheduled posts may not work', {
      message: error.message,
    });
  }

  startMetaReadinessLoop();
};

start().catch((error) => {
  logger.error('Failed to start Meta Genie server', { message: error.message });
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
