
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const createOAuthState = async (payload, ttlMs = DEFAULT_TTL_MS) => {
  const state = uuidv4();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  await query(
    `INSERT INTO oauth_state_store (state, payload, expires_at)
     VALUES ($1, $2::jsonb, $3)`,
    [state, JSON.stringify(payload), expiresAt]
  );

  return state;
};

export const consumeOAuthState = async (state) => {
  const result = await query(
    `DELETE FROM oauth_state_store
     WHERE state = $1 AND expires_at > NOW()
     RETURNING payload`,
    [state]
  );

  if (!result.rows[0]) return null;
  return result.rows[0].payload;
};
