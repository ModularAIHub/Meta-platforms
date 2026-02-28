import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const DB_DEBUG = process.env.DB_DEBUG === 'true';
const DB_ERROR_LOG_THROTTLE_MS = Number.parseInt(process.env.DB_ERROR_LOG_THROTTLE_MS || '30000', 10);
const DB_QUERY_MAX_RETRIES = Number.parseInt(process.env.DB_QUERY_MAX_RETRIES || '2', 10);
const DB_QUERY_RETRY_DELAY_MS = Number.parseInt(process.env.DB_QUERY_RETRY_DELAY_MS || '250', 10);
const DB_POOL_MAX_USES = Number.parseInt(process.env.DB_POOL_MAX_USES || '7500', 10);

let hasLoggedConnect = false;
let lastDbErrorAt = 0;

const dbDebug = (...args) => {
  if (DB_DEBUG) {
    console.log(...args);
  }
};

const dbError = (...args) => {
  const now = Date.now();
  if (now - lastDbErrorAt < DB_ERROR_LOG_THROTTLE_MS) {
    return;
  }
  lastDbErrorAt = now;
  console.error(...args);
};

const DATABASE_URL = process.env.DATABASE_URL || '';
const isSupabaseConnection =
  DATABASE_URL.includes('supabase.com') || DATABASE_URL.includes('supabase.co');

const config = DATABASE_URL
  ? {
      connectionString: DATABASE_URL,
      ssl:
        process.env.DB_SSL === 'true' ||
        (process.env.DB_SSL !== 'false' &&
          (process.env.NODE_ENV === 'production' || isSupabaseConnection))
          ? { rejectUnauthorized: false }
          : false,
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number.parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'social_genie',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl:
        process.env.DB_SSL === 'true' ||
        (process.env.DB_SSL !== 'false' &&
          (process.env.NODE_ENV === 'production' || isSupabaseConnection))
          ? { rejectUnauthorized: false }
          : false,
    };

Object.assign(config, {
  max: Number.parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: Number.parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMillis: Number.parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS || '10000', 10),
  statement_timeout: Number.parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000', 10),
  query_timeout: Number.parseInt(process.env.DB_QUERY_TIMEOUT_MS || '30000', 10),
  maxUses: Number.isFinite(DB_POOL_MAX_USES) && DB_POOL_MAX_USES > 0 ? DB_POOL_MAX_USES : 7500,
  keepAlive: true,
});

export const pool = new Pool(config);

pool.on('connect', () => {
  if (hasLoggedConnect) return;
  hasLoggedConnect = true;
  dbDebug('Connected to Social Genie database');
});

pool.on('error', (error) => {
  dbError('[db] pool error', error?.message || error);
});

const isRetryableConnectionError = (error) => {
  if (!error) return false;
  const message = String(error.message || '').toLowerCase();
  const code = String(error.code || '').toUpperCase();

  if (message.includes('connection terminated')) return true;
  if (message.includes('connection timeout')) return true;
  if (message.includes('econnreset')) return true;
  if (message.includes('getaddrinfo')) return true;
  if (message.includes('enotfound')) return true;
  if (message.includes('eai_again')) return true;
  if (message.includes('connect eacces')) return true;
  if (code.startsWith('08')) return true;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EACCES' || code === 'EPERM') return true;
  if (code === '57P01' || code === '57P02' || code === '57P03') return true;
  return false;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const originalQuery = pool.query.bind(pool);
pool.query = async (...args) => {
  if (typeof args[args.length - 1] === 'function') {
    return originalQuery(...args);
  }

  let attempt = 0;
  const maxRetries = Number.isFinite(DB_QUERY_MAX_RETRIES) && DB_QUERY_MAX_RETRIES >= 0
    ? DB_QUERY_MAX_RETRIES
    : 2;

  while (true) {
    try {
      return await originalQuery(...args);
    } catch (error) {
      if (!isRetryableConnectionError(error) || attempt >= maxRetries) {
        throw error;
      }

      attempt += 1;
      const delayMs = (Number.isFinite(DB_QUERY_RETRY_DELAY_MS) ? DB_QUERY_RETRY_DELAY_MS : 250) * attempt;
      dbError(`[db] retrying query after transient connection error (attempt ${attempt}/${maxRetries})`, error?.message || error);
      await sleep(delayMs);
    }
  }
};

export const query = (text, params = []) => pool.query(text, params);

export default pool;
