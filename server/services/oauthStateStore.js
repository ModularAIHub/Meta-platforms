import { v4 as uuidv4 } from 'uuid';

const stateStore = new Map();

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export const createOAuthState = (payload, ttlMs = DEFAULT_TTL_MS) => {
  const state = uuidv4();
  stateStore.set(state, {
    payload,
    expiresAt: Date.now() + ttlMs,
  });

  setTimeout(() => {
    stateStore.delete(state);
  }, ttlMs).unref?.();

  return state;
};

export const consumeOAuthState = (state) => {
  const entry = stateStore.get(state);
  if (!entry) return null;

  stateStore.delete(state);

  if (Date.now() > entry.expiresAt) {
    return null;
  }

  return entry.payload;
};
