import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { publishInstagramPost } from '../services/instagramService.js';
import { publishThreadsPost, publishThreadsThread } from '../services/threadsService.js';
import { publishYoutubeVideo } from '../services/youtubeService.js';
import { mapSocialPublishError } from '../utils/publishErrors.js';
import { logger } from '../utils/logger.js';

const router = express.Router();
const THREADS_TEXT_MAX_CHARS = Math.max(120, Number.parseInt(process.env.THREADS_TEXT_MAX_CHARS || '500', 10));
const THREADS_MAX_CHAIN_POSTS = Math.max(2, Number.parseInt(process.env.THREADS_MAX_CHAIN_POSTS || '30', 10));
let metadataColumnChecked = false;
let metadataColumnAvailable = false;

const ensureInternalRequest = (req, res, next) => {
  const configuredKey = String(process.env.INTERNAL_API_KEY || '').trim();
  const providedKey = String(req.headers['x-internal-api-key'] || '').trim();

  if (!configuredKey) {
    return res.status(503).json({
      error: 'Internal API key is not configured',
      code: 'INTERNAL_API_KEY_NOT_CONFIGURED',
    });
  }

  if (!providedKey || providedKey !== configuredKey) {
    return res.status(403).json({
      error: 'Forbidden',
      code: 'INTERNAL_AUTH_FAILED',
    });
  }

  req.isInternal = true;
  return next();
};

const resolvePlatformUserId = (req) => String(req.headers['x-platform-user-id'] || '').trim();
const resolvePlatformTeamId = (req) => String(req.headers['x-platform-team-id'] || '').trim() || null;
const trimText = (value, maxLength = 5000) => String(value || '').trim().slice(0, maxLength);
const isTokenExpired = (value) => {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now();
};

const normalizeMediaUrls = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 12);
};

const normalizeThreadParts = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => trimText(item, THREADS_TEXT_MAX_CHARS))
    .filter(Boolean)
    .slice(0, THREADS_MAX_CHAIN_POSTS);
};

const parseMetadata = (value, fallback = {}) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...fallback, ...value };
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...fallback, ...parsed };
      }
    } catch {
      return { ...fallback };
    }
  }
  return { ...fallback };
};

const inferThreadsContentType = (mediaUrls = []) => {
  const first = String(mediaUrls[0] || '').toLowerCase();
  if (!first) return 'text';
  return /\.(mp4|mov|m4v|webm|avi|mpeg|mpg)(\?|$)/i.test(first) ? 'video' : 'image';
};

const splitTextByLimit = (value, limit) => {
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.length <= limit) return [text];

  const parts = [];
  let remaining = text;
  while (remaining.length > limit && parts.length < THREADS_MAX_CHAIN_POSTS) {
    let cut = remaining.lastIndexOf(' ', limit);
    if (cut < Math.floor(limit * 0.6)) {
      cut = limit;
    }
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining && parts.length < THREADS_MAX_CHAIN_POSTS) {
    parts.push(remaining);
  }
  return parts.filter(Boolean);
};

const ensureMetadataColumnSupport = async () => {
  if (metadataColumnChecked) return metadataColumnAvailable;

  try {
    try {
      await query(
        `ALTER TABLE social_posts
         ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`
      );
    } catch {
      // Continue to inspection.
    }

    const result = await query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'social_posts'
         AND column_name = 'metadata'
       LIMIT 1`
    );
    metadataColumnAvailable = result.rows.length > 0;
  } catch {
    metadataColumnAvailable = false;
  } finally {
    metadataColumnChecked = true;
  }

  return metadataColumnAvailable;
};

const getConnectedAccount = async ({ userId, teamId, platform, targetAccountId = null }) => {
  const params = [];
  const filters = [`platform = $1`, `is_active = true`];
  params.push(platform);

  if (teamId) {
    params.push(teamId);
    filters.push(`team_id::text = $${params.length}::text`);
  } else {
    params.push(userId);
    filters.push(`user_id::text = $${params.length}::text`);
    filters.push(`team_id IS NULL`);
  }

  if (targetAccountId) {
    params.push(String(targetAccountId));
    filters.push(`id::text = $${params.length}::text`);
  }

  const result = await query(
    `SELECT id, user_id, team_id, platform, account_id, access_token, refresh_token, token_expires_at, metadata
     FROM social_connected_accounts
     WHERE ${filters.join(' AND ')}
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    params
  );

  return result.rows[0] || null;
};

const insertSocialPost = async ({
  userId,
  teamId = null,
  caption,
  mediaUrls = [],
  platform,
  status,
  scheduledFor = null,
  postedAt = null,
  instagramContentType = null,
  youtubeContentType = null,
  threadsContentType = null,
  instagramPostId = null,
  youtubeVideoId = null,
  threadsPostId = null,
  threadsSequence = [],
  metadata = {},
}) => {
  const postId = uuidv4();
  const canWriteMetadata = await ensureMetadataColumnSupport();
  const baseValues = [
    postId,
    userId,
    teamId,
    caption,
    JSON.stringify(mediaUrls || []),
    JSON.stringify([platform]),
    false,
    instagramContentType,
    youtubeContentType,
    threadsContentType,
    status,
    scheduledFor,
    postedAt,
    instagramPostId,
    youtubeVideoId,
    threadsPostId,
    JSON.stringify(threadsSequence || []),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];

  if (canWriteMetadata) {
    await query(
      `INSERT INTO social_posts (
         id, user_id, team_id, caption, media_urls, platforms, cross_post,
         instagram_content_type, youtube_content_type, threads_content_type,
         status, scheduled_for, posted_at,
         instagram_post_id, youtube_video_id, threads_post_id, threads_sequence,
         instagram_likes, instagram_comments, instagram_reach,
         youtube_views, youtube_watch_time_minutes, youtube_subscribers_gained,
         threads_likes, threads_replies, threads_views,
         metadata, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7,
         $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16, $17::jsonb,
         $18, $19, $20,
         $21, $22, $23,
         $24, $25, $26,
         $27::jsonb, NOW(), NOW()
       )`,
      [...baseValues, JSON.stringify(metadata || {})]
    );
  } else {
    await query(
      `INSERT INTO social_posts (
         id, user_id, team_id, caption, media_urls, platforms, cross_post,
         instagram_content_type, youtube_content_type, threads_content_type,
         status, scheduled_for, posted_at,
         instagram_post_id, youtube_video_id, threads_post_id, threads_sequence,
         instagram_likes, instagram_comments, instagram_reach,
         youtube_views, youtube_watch_time_minutes, youtube_subscribers_gained,
         threads_likes, threads_replies, threads_views,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7,
         $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16, $17::jsonb,
         $18, $19, $20,
         $21, $22, $23,
         $24, $25, $26,
         NOW(), NOW()
       )`,
      baseValues
    );
  }

  const created = await query(`SELECT * FROM social_posts WHERE id = $1 LIMIT 1`, [postId]);
  return created.rows[0] || null;
};

router.post('/', ensureInternalRequest, async (req, res) => {
  const platformUserId = resolvePlatformUserId(req);
  const platformTeamId = resolvePlatformTeamId(req);
  const {
    platform,
    content = '',
    media = [],
    mediaUrls = [],
    postMode = 'single',
    threadParts = [],
    postNow = true,
    scheduledFor = null,
    instagramContentType = 'feed',
    youtubeContentType = 'video',
    threadsContentType = 'text',
    targetAccountId = null,
    metadata = {},
  } = req.body || {};

  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const normalizedContent = trimText(content, 5000);
  const normalizedMedia = normalizeMediaUrls(Array.isArray(media) && media.length > 0 ? media : mediaUrls);
  const normalizedMode = String(postMode || 'single').trim().toLowerCase() === 'thread' ? 'thread' : 'single';
  const normalizedThreadParts = normalizeThreadParts(threadParts);

  if (!platformUserId) {
    return res.status(400).json({
      error: 'x-platform-user-id is required',
      code: 'PLATFORM_USER_ID_REQUIRED',
    });
  }

  if (!['threads', 'instagram', 'youtube'].includes(normalizedPlatform)) {
    return res.status(400).json({
      error: 'Unsupported social platform',
      code: 'SOCIAL_PLATFORM_UNSUPPORTED',
    });
  }

  if (normalizedPlatform === 'threads' && normalizedMode === 'thread' && normalizedThreadParts.length < 2) {
    return res.status(400).json({
      error: 'threadParts must contain at least 2 posts for thread mode',
      code: 'THREADS_CHAIN_MIN_POSTS',
    });
  }

  if (normalizedPlatform !== 'threads' && !normalizedContent) {
    return res.status(400).json({
      error: 'content is required',
      code: 'SOCIAL_CONTENT_REQUIRED',
    });
  }

  if (!postNow) {
    const parsedScheduledFor = new Date(scheduledFor);
    if (!scheduledFor || Number.isNaN(parsedScheduledFor.getTime()) || parsedScheduledFor.getTime() <= Date.now()) {
      return res.status(400).json({
        error: 'scheduledFor must be a future datetime',
        code: 'SOCIAL_SCHEDULE_INVALID',
      });
    }
  }

  try {
    const account = await getConnectedAccount({
      userId: platformUserId,
      teamId: platformTeamId,
      platform: normalizedPlatform,
      targetAccountId,
    });

    if (!account) {
      return res.status(404).json({
        error: `${normalizedPlatform} account not connected`,
        code: 'SOCIAL_ACCOUNT_NOT_CONNECTED',
      });
    }

    if (isTokenExpired(account.token_expires_at)) {
      return res.status(401).json({
        error: `${normalizedPlatform} token expired. Reconnect the account.`,
        code: 'SOCIAL_TOKEN_EXPIRED',
      });
    }

    const baseMetadata = {
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
      agency_workspace: {
        source: 'agency_workspace',
        createdAt: new Date().toISOString(),
      },
      target_account_ids: {
        [normalizedPlatform]: String(account.id),
      },
    };

    if (!postNow) {
      const scheduledPost = await insertSocialPost({
        userId: platformUserId,
        teamId: platformTeamId,
        caption: normalizedContent || normalizedThreadParts[0] || '',
        mediaUrls: normalizedMedia,
        platform: normalizedPlatform,
        status: 'scheduled',
        scheduledFor: new Date(scheduledFor).toISOString(),
        instagramContentType: normalizedPlatform === 'instagram' ? String(instagramContentType || 'feed') : null,
        youtubeContentType: normalizedPlatform === 'youtube' ? String(youtubeContentType || 'video') : null,
        threadsContentType: normalizedPlatform === 'threads'
          ? (normalizedMode === 'thread' ? 'thread' : inferThreadsContentType(normalizedMedia))
          : null,
        threadsSequence: normalizedPlatform === 'threads' && normalizedMode === 'thread' ? normalizedThreadParts : [],
        metadata: baseMetadata,
      });

      return res.json({
        success: true,
        status: 'scheduled',
        post: scheduledPost,
        scheduledPostId: scheduledPost?.id || null,
        scheduledFor: scheduledPost?.scheduled_for || new Date(scheduledFor).toISOString(),
      });
    }

    let instagramPostId = null;
    let youtubeVideoId = null;
    let threadsPostId = null;
    let threadsSequence = [];
    let finalThreadsContentType = null;

    if (normalizedPlatform === 'instagram') {
      if (!account.account_id || !account.access_token) {
        return res.status(400).json({ error: 'Instagram account is missing token/account details', code: 'INSTAGRAM_TOKEN_MISSING' });
      }

      if (!normalizedMedia.length) {
        return res.status(400).json({ error: 'Instagram publishing requires at least one media URL', code: 'INSTAGRAM_MEDIA_REQUIRED' });
      }

      const publishResult = await publishInstagramPost({
        accountId: account.account_id,
        accessToken: account.access_token,
        mediaUrls: normalizedMedia,
        caption: normalizedContent,
        contentType: String(instagramContentType || 'feed'),
        requestHost: req.get('host') || null,
      });
      instagramPostId = publishResult.publishId || publishResult.creationId || null;
    }

    if (normalizedPlatform === 'youtube') {
      if (!account.account_id || !account.access_token) {
        return res.status(400).json({ error: 'YouTube account is missing token/account details', code: 'YOUTUBE_TOKEN_MISSING' });
      }

      const publishResult = await publishYoutubeVideo({
        connection: account,
        mediaUrls: normalizedMedia,
        caption: normalizedContent,
        contentType: String(youtubeContentType || 'video'),
      });
      youtubeVideoId = publishResult.videoId || null;
    }

    if (normalizedPlatform === 'threads') {
      if (!account.account_id || !account.access_token) {
        return res.status(400).json({ error: 'Threads account is missing token/account details', code: 'THREADS_TOKEN_MISSING' });
      }

      if (normalizedMode === 'thread') {
        const publishResult = await publishThreadsThread({
          accountId: account.account_id,
          accessToken: account.access_token,
          posts: normalizedThreadParts,
        });
        threadsPostId = publishResult.publishId || null;
        threadsSequence = Array.isArray(publishResult.threadPostIds) ? publishResult.threadPostIds : [];
        finalThreadsContentType = 'thread';
      } else {
        const splitContent = normalizedContent.length > THREADS_TEXT_MAX_CHARS && normalizedMedia.length === 0
          ? splitTextByLimit(normalizedContent, THREADS_TEXT_MAX_CHARS)
          : [];

        if (splitContent.length >= 2) {
          const publishResult = await publishThreadsThread({
            accountId: account.account_id,
            accessToken: account.access_token,
            posts: splitContent,
          });
          threadsPostId = publishResult.publishId || null;
          threadsSequence = Array.isArray(publishResult.threadPostIds) ? publishResult.threadPostIds : [];
          finalThreadsContentType = 'thread';
        } else {
          finalThreadsContentType = inferThreadsContentType(normalizedMedia);
          const publishResult = await publishThreadsPost({
            accountId: account.account_id,
            accessToken: account.access_token,
            text: normalizedContent,
            mediaUrls: normalizedMedia,
            contentType: finalThreadsContentType,
            requestHost: req.get('host') || null,
          });
          threadsPostId = publishResult.publishId || publishResult.creationId || null;
        }
      }
    }

    const created = await insertSocialPost({
      userId: platformUserId,
      teamId: platformTeamId,
      caption: normalizedContent || normalizedThreadParts[0] || '',
      mediaUrls: normalizedMedia,
      platform: normalizedPlatform,
      status: 'posted',
      postedAt: new Date().toISOString(),
      instagramContentType: normalizedPlatform === 'instagram' ? String(instagramContentType || 'feed') : null,
      youtubeContentType: normalizedPlatform === 'youtube' ? String(youtubeContentType || 'video') : null,
      threadsContentType: normalizedPlatform === 'threads' ? finalThreadsContentType : null,
      instagramPostId,
      youtubeVideoId,
      threadsPostId,
      threadsSequence,
      metadata: baseMetadata,
    });

    return res.json({
      success: true,
      status: 'posted',
      post: created,
      publishId: instagramPostId || threadsPostId || youtubeVideoId || null,
      threadPostIds: normalizedPlatform === 'threads' ? threadsSequence : [],
      videoId: youtubeVideoId,
    });
  } catch (error) {
    const mappedError = mapSocialPublishError(error, { platform: normalizedPlatform });
    logger.error('[internal/posts] Failed to process social workspace post', {
      userId: platformUserId,
      teamId: platformTeamId,
      platform: normalizedPlatform,
      error: mappedError?.message || error?.message || String(error),
    });

    return res.status(mappedError?.status || 500).json({
      error: mappedError?.message || 'Failed to process social post',
      code: mappedError?.code || 'SOCIAL_INTERNAL_POST_FAILED',
    });
  }
});

router.post('/analytics-summary', ensureInternalRequest, async (req, res) => {
  const platformUserId = resolvePlatformUserId(req);
  const platformTeamId = resolvePlatformTeamId(req);
  const days = Math.max(1, Math.min(Number.parseInt(req.body?.days || '30', 10), 365));

  if (!platformUserId) {
    return res.status(400).json({
      error: 'x-platform-user-id is required',
      code: 'PLATFORM_USER_ID_REQUIRED',
    });
  }

  try {
    const params = [];
    const filters = [];

    if (platformTeamId) {
      params.push(platformTeamId);
      filters.push(`team_id::text = $${params.length}::text`);
    } else {
      params.push(platformUserId);
      filters.push(`user_id::text = $${params.length}::text`);
      filters.push(`(team_id IS NULL OR team_id::text = '')`);
    }

    params.push(days);
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'posted')::int AS total_posted,
         COUNT(*) FILTER (WHERE status = 'scheduled')::int AS total_scheduled,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS total_failed,
         COUNT(*) FILTER (WHERE status = 'posted' AND platforms ? 'threads')::int AS threads_posts,
         COUNT(*) FILTER (WHERE status = 'posted' AND platforms ? 'instagram')::int AS instagram_posts,
         COUNT(*) FILTER (WHERE status = 'posted' AND platforms ? 'youtube')::int AS youtube_posts,
         COALESCE(SUM(threads_likes), 0)::bigint AS threads_likes,
         COALESCE(SUM(threads_replies), 0)::bigint AS threads_replies,
         COALESCE(SUM(threads_views), 0)::bigint AS threads_views,
         COALESCE(SUM(instagram_likes), 0)::bigint AS instagram_likes,
         COALESCE(SUM(instagram_comments), 0)::bigint AS instagram_comments,
         COALESCE(SUM(instagram_reach), 0)::bigint AS instagram_reach,
         COALESCE(SUM(youtube_views), 0)::bigint AS youtube_views
       FROM social_posts
       WHERE ${filters.join(' AND ')}
         AND COALESCE(posted_at, scheduled_for, created_at) >= NOW() - ($${params.length}::text || ' days')::interval`,
      params
    );

    const row = result.rows[0] || {};
    return res.json({
      success: true,
      totalPosted: Number(row.total_posted || 0),
      totalScheduled: Number(row.total_scheduled || 0),
      totalFailed: Number(row.total_failed || 0),
      threadsPosts: Number(row.threads_posts || 0),
      instagramPosts: Number(row.instagram_posts || 0),
      youtubePosts: Number(row.youtube_posts || 0),
      threadsLikes: Number(row.threads_likes || 0),
      threadsReplies: Number(row.threads_replies || 0),
      threadsViews: Number(row.threads_views || 0),
      instagramLikes: Number(row.instagram_likes || 0),
      instagramComments: Number(row.instagram_comments || 0),
      instagramReach: Number(row.instagram_reach || 0),
      youtubeViews: Number(row.youtube_views || 0),
    });
  } catch (error) {
    logger.error('[internal/posts/analytics-summary] Failed to build social summary', {
      userId: platformUserId,
      teamId: platformTeamId,
      error: error?.message || String(error),
    });
    return res.status(500).json({
      error: 'Failed to fetch social analytics summary',
      code: 'SOCIAL_ANALYTICS_SUMMARY_FAILED',
    });
  }
});

export default router;
