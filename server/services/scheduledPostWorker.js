import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { publishInstagramPost } from './instagramService.js';
import { publishThreadsPost, publishThreadsThread } from './threadsService.js';
import { publishYoutubeVideo } from './youtubeService.js';
import { mapSocialPublishError } from '../utils/publishErrors.js';

const WORKER_ENABLED = String(process.env.SOCIAL_SCHEDULE_WORKER_ENABLED || 'true').toLowerCase() === 'true';
const WORKER_POLL_MS = Math.max(5000, Number.parseInt(process.env.SOCIAL_SCHEDULE_WORKER_POLL_MS || '15000', 10));
const WORKER_BATCH_SIZE = Math.max(1, Number.parseInt(process.env.SOCIAL_SCHEDULE_WORKER_BATCH_SIZE || '5', 10));
const THREADS_TEXT_MAX_CHARS = Math.max(120, Number.parseInt(process.env.THREADS_TEXT_MAX_CHARS || '500', 10));

let pollTimer = null;
let isRunning = false;

const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const splitTextByLimit = (text, limit = THREADS_TEXT_MAX_CHARS) => {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  if (normalized.length <= limit) return [normalized];

  const parts = [];
  let remaining = normalized;
  const softFloor = Math.floor(limit * 0.55);

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit + 1);
    let cut = -1;

    const newlineCut = slice.lastIndexOf('\n');
    if (newlineCut >= softFloor) cut = newlineCut;

    if (cut < softFloor) {
      const sentenceCut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      if (sentenceCut >= softFloor) cut = sentenceCut + 1;
    }

    if (cut < softFloor) {
      const spaceCut = slice.lastIndexOf(' ');
      if (spaceCut >= softFloor) cut = spaceCut;
    }

    if (cut < softFloor) cut = limit;

    const part = remaining.slice(0, cut).trim();
    if (part) parts.push(part);
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
};

const getConnectedAccountByPlatform = async (post, platform) => {
  if (post.team_id) {
    const result = await query(
      `SELECT id, account_id, access_token, refresh_token, token_expires_at
       FROM social_connected_accounts
       WHERE team_id = $1 AND platform = $2 AND is_active = true
       ORDER BY updated_at DESC
       LIMIT 1`,
      [post.team_id, platform]
    );
    return result.rows[0] || null;
  }

  const result = await query(
    `SELECT id, account_id, access_token, refresh_token, token_expires_at
     FROM social_connected_accounts
     WHERE user_id = $1 AND team_id IS NULL AND platform = $2 AND is_active = true
     ORDER BY updated_at DESC
     LIMIT 1`,
    [post.user_id, platform]
  );
  return result.rows[0] || null;
};

const claimDuePosts = async () => {
  const result = await query(
    `UPDATE social_posts
     SET status = 'publishing',
         updated_at = NOW()
     WHERE id IN (
       SELECT id
       FROM social_posts
       WHERE status = 'scheduled'
         AND scheduled_for IS NOT NULL
         AND scheduled_for <= NOW()
       ORDER BY scheduled_for ASC
       LIMIT $1
     )
     RETURNING *`,
    [WORKER_BATCH_SIZE]
  );

  return result.rows;
};

const markFailed = async (postId, errorMessage) => {
  await query(
    `UPDATE social_posts
     SET status = 'failed',
         updated_at = NOW()
     WHERE id = $1`,
    [postId]
  );

  logger.warn('Scheduled post publish failed', {
    postId,
    error: errorMessage,
  });
};

const markPosted = async ({ postId, instagramPostId, youtubeVideoId, threadsPostId }) => {
  await query(
    `UPDATE social_posts
     SET status = 'posted',
         posted_at = NOW(),
         instagram_post_id = COALESCE($2, instagram_post_id),
         youtube_video_id = COALESCE($3, youtube_video_id),
         threads_post_id = COALESCE($4, threads_post_id),
         updated_at = NOW()
     WHERE id = $1`,
    [postId, instagramPostId, youtubeVideoId, threadsPostId]
  );
};

const publishScheduledPost = async (post) => {
  const platforms = parseJsonArray(post.platforms).map((platform) => String(platform).toLowerCase());
  const mediaUrls = parseJsonArray(post.media_urls);
  const threadsSequence = parseJsonArray(post.threads_sequence)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const caption = String(post.caption || '').trim();

  let instagramPostId = null;
  let youtubeVideoId = null;
  let threadsPostId = null;

  for (const platform of platforms) {
    if (platform === 'instagram') {
      const account = await getConnectedAccountByPlatform(post, 'instagram');
      if (!account?.account_id || !account?.access_token) {
        throw mapSocialPublishError(new Error('Instagram account is not connected'), { platform: 'instagram' });
      }

      try {
        const publishResult = await publishInstagramPost({
          accountId: account.account_id,
          accessToken: account.access_token,
          mediaUrls,
          caption,
          contentType: post.instagram_content_type || 'feed',
          requestHost: null,
        });

        instagramPostId = publishResult.publishId || publishResult.creationId || null;
      } catch (error) {
        throw mapSocialPublishError(error, { platform: 'instagram' });
      }
    }

    if (platform === 'threads') {
      const account = await getConnectedAccountByPlatform(post, 'threads');
      if (!account?.account_id || !account?.access_token) {
        throw mapSocialPublishError(new Error('Threads account is not connected'), { platform: 'threads' });
      }

      const threadsType = String(post.threads_content_type || 'text').toLowerCase();
      try {
        if (threadsType === 'thread') {
          const posts = threadsSequence.length >= 2 ? threadsSequence : splitTextByLimit(caption, THREADS_TEXT_MAX_CHARS);
          if (posts.length < 2) {
            throw new Error('Threads chain requires at least 2 posts');
          }

          const publishResult = await publishThreadsThread({
            accountId: account.account_id,
            accessToken: account.access_token,
            posts,
          });
          threadsPostId = publishResult.publishId || null;
        } else {
          const publishResult = await publishThreadsPost({
            accountId: account.account_id,
            accessToken: account.access_token,
            text: caption,
            mediaUrls,
            contentType: threadsType,
            requestHost: null,
          });
          threadsPostId = publishResult.publishId || publishResult.creationId || null;
        }
      } catch (error) {
        throw mapSocialPublishError(error, { platform: 'threads' });
      }
    }

    if (platform === 'youtube') {
      const account = await getConnectedAccountByPlatform(post, 'youtube');
      if (!account?.account_id || !account?.access_token) {
        throw mapSocialPublishError(new Error('YouTube account is not connected'), { platform: 'youtube' });
      }

      try {
        const publishResult = await publishYoutubeVideo({
          connection: account,
          mediaUrls,
          caption,
          contentType: post.youtube_content_type || 'video',
        });
        youtubeVideoId = publishResult.videoId || null;
      } catch (error) {
        throw mapSocialPublishError(error, { platform: 'youtube' });
      }
    }
  }

  await markPosted({
    postId: post.id,
    instagramPostId,
    youtubeVideoId,
    threadsPostId,
  });

  logger.info('Scheduled post published', {
    postId: post.id,
    platforms,
  });
};

const tick = async () => {
  if (isRunning) {
    return;
  }

  isRunning = true;
  try {
    const duePosts = await claimDuePosts();
    if (duePosts.length === 0) {
      return;
    }

    for (const post of duePosts) {
      try {
        await publishScheduledPost(post);
      } catch (error) {
        await markFailed(post.id, error?.message || 'Unknown publish failure');
      }
    }
  } catch (error) {
    logger.error('Scheduled worker tick failed', { message: error?.message || String(error) });
  } finally {
    isRunning = false;
  }
};

export const startScheduledPostWorker = () => {
  if (!WORKER_ENABLED) {
    logger.info('Scheduled post worker disabled via SOCIAL_SCHEDULE_WORKER_ENABLED');
    return;
  }

  if (pollTimer) {
    return;
  }

  logger.info('Scheduled post worker started', {
    pollMs: WORKER_POLL_MS,
    batchSize: WORKER_BATCH_SIZE,
  });

  tick().catch(() => null);
  pollTimer = setInterval(() => {
    tick().catch(() => null);
  }, WORKER_POLL_MS);
};

export const stopScheduledPostWorker = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};
