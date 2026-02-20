import { query } from './database.js';

const statements = [
  `
    CREATE TABLE IF NOT EXISTS social_connected_accounts (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      team_id UUID,
      platform VARCHAR(50) NOT NULL,
      account_id VARCHAR(255) NOT NULL,
      account_username VARCHAR(255),
      account_display_name VARCHAR(255),
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at TIMESTAMPTZ,
      profile_image_url TEXT,
      followers_count BIGINT DEFAULT 0,
      metadata JSONB DEFAULT '{}'::jsonb,
      connected_by UUID,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_social_connected_accounts_active
    ON social_connected_accounts(team_id, platform, account_id)
    WHERE is_active = true;
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_social_connected_accounts_user
    ON social_connected_accounts(user_id, platform);
  `,
  `
    CREATE TABLE IF NOT EXISTS social_posts (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      team_id UUID,
      caption TEXT,
      media_urls JSONB DEFAULT '[]'::jsonb,
      platforms JSONB DEFAULT '[]'::jsonb,
      cross_post BOOLEAN DEFAULT false,
      instagram_content_type VARCHAR(50),
      youtube_content_type VARCHAR(50),
      threads_content_type VARCHAR(50),
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      scheduled_for TIMESTAMPTZ,
      posted_at TIMESTAMPTZ,
      instagram_post_id VARCHAR(255),
      youtube_video_id VARCHAR(255),
      threads_post_id VARCHAR(255),
      threads_sequence JSONB DEFAULT '[]'::jsonb,
      instagram_likes BIGINT DEFAULT 0,
      instagram_comments BIGINT DEFAULT 0,
      instagram_reach BIGINT DEFAULT 0,
      youtube_views BIGINT DEFAULT 0,
      youtube_watch_time_minutes NUMERIC(12,2) DEFAULT 0,
      youtube_subscribers_gained BIGINT DEFAULT 0,
      threads_likes BIGINT DEFAULT 0,
      threads_replies BIGINT DEFAULT 0,
      threads_views BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `,
  `
    ALTER TABLE social_posts
    ADD COLUMN IF NOT EXISTS threads_content_type VARCHAR(50);
  `,
  `
    ALTER TABLE social_posts
    ADD COLUMN IF NOT EXISTS threads_post_id VARCHAR(255);
  `,
  `
    ALTER TABLE social_posts
    ADD COLUMN IF NOT EXISTS threads_sequence JSONB DEFAULT '[]'::jsonb;
  `,
  `
    ALTER TABLE social_posts
    ADD COLUMN IF NOT EXISTS threads_likes BIGINT DEFAULT 0;
  `,
  `
    ALTER TABLE social_posts
    ADD COLUMN IF NOT EXISTS threads_replies BIGINT DEFAULT 0;
  `,
  `
    ALTER TABLE social_posts
    ADD COLUMN IF NOT EXISTS threads_views BIGINT DEFAULT 0;
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_social_posts_team_status_schedule
    ON social_posts(team_id, status, scheduled_for);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_social_posts_user_created
    ON social_posts(user_id, created_at DESC);
  `,
];

export const ensureSchema = async () => {
  for (const statement of statements) {
    await query(statement);
  }
};
