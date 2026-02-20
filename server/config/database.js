import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || '';

const config = DATABASE_URL
  ? {
      connectionString: DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' || process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number.parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'social_genie',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };

Object.assign(config, {
  max: Number.parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: Number.parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMillis: Number.parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS || '10000', 10),
  statement_timeout: Number.parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000', 10),
  query_timeout: Number.parseInt(process.env.DB_QUERY_TIMEOUT_MS || '30000', 10),
});

export const pool = new Pool(config);

pool.on('error', (error) => {
  console.error('[db] pool error', error?.message || error);
});

export const query = (text, params = []) => pool.query(text, params);

export default pool;
