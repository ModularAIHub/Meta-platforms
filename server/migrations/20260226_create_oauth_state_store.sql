-- Step 1: Create oauth_state_store table for OAuth state persistence
CREATE TABLE IF NOT EXISTS oauth_state_store (
  state       TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-cleanup old states
CREATE INDEX IF NOT EXISTS idx_oauth_state_expires ON oauth_state_store (expires_at);
