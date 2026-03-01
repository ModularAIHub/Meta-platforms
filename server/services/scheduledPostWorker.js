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
const X_CROSSPOST_TIMEOUT_MS = Number.parseInt(process.env.X_CROSSPOST_TIMEOUT_MS || '10000', 10);
const LINKEDIN_CROSSPOST_TIMEOUT_MS = Number.parseInt(process.env.LINKEDIN_CROSSPOST_TIMEOUT_MS || '10000', 10);
const INTERNAL_CALLER = 'social-genie-scheduler';

let pollTimer = null;
let isRunning = false;
let metadataColumnChecked = false;
let metadataColumnAvailable = false;

const isTransientDbError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  if (message.includes('connection terminated')) return true;
  if (message.includes('connection timeout')) return true;
  if (message.includes('econnreset')) return true;
  if (message.includes('terminating connection due to administrator command')) return true;
  if (code.startsWith('08')) return true;
  return false;
};

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

const parseJsonObject = (value, fallback = {}) => {
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

const detectMedia = (mediaUrls) =>
  Array.isArray(mediaUrls) && mediaUrls.some((url) => String(url || '').trim().length > 0);

const buildInternalServiceHeaders = ({ userId, internalApiKey, teamId = null }) => ({
  'Content-Type': 'application/json',
  'x-internal-api-key': internalApiKey,
  'x-internal-caller': INTERNAL_CALLER,
  'x-platform-user-id': String(userId),
  ...(teamId ? { 'x-platform-team-id': String(teamId) } : {}),
});

const buildInternalServiceEndpoint = (baseUrl, path) =>
  `${String(baseUrl || '').trim().replace(/\/$/, '')}${path}`;

const postInternalJson = async ({ endpoint, userId, teamId = null, internalApiKey, payload, timeoutMs = 0 }) => {
  const controller = Number.isFinite(timeoutMs) && timeoutMs > 0 ? new AbortController() : null;
  let timeoutId = null;
  try {
    if (controller) timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: buildInternalServiceHeaders({ userId, internalApiKey, teamId }),
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const normalizeCrossPostMedia = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 4);
};

const absolutizeSocialMediaUrlsForCrossPost = (mediaUrls = []) => {
  const baseUrl = String(process.env.SOCIAL_GENIE_URL || '').trim();
  return normalizeCrossPostMedia(mediaUrls)
    .map((item) => {
      if (/^https?:\/\//i.test(item) || item.startsWith('data:')) return item;

      if (item.startsWith('/')) {
        if (baseUrl) return buildInternalServiceEndpoint(baseUrl, item);
        // baseUrl missing -> warn and drop this relative path
        logger.warn('absolutizeSocialMediaUrlsForCrossPost: dropping relative path because SOCIAL_GENIE_URL is not configured', { item });
        return null;
      }

      // Non-slash relative path (e.g., 'uploads/img.png')
      if (baseUrl) {
        const normalizedPath = `/${String(item).replace(/^\/+/, '')}`;
        return buildInternalServiceEndpoint(baseUrl, normalizedPath);
      }

      // No baseUrl to resolve relative path -> drop and warn
      logger.warn('absolutizeSocialMediaUrlsForCrossPost: dropping relative path because SOCIAL_GENIE_URL is not configured', { item });
      return null;
    })
    .filter(Boolean);
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
      // continue to schema inspection
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

const crossPostToX = async ({ userId, teamId = null, content, mediaDetected = false, mediaUrls = [], targetAccountId = null }) => {
  const tweetGenieUrl = String(process.env.TWEET_GENIE_URL || '').trim();
  const internalApiKey = String(process.env.INTERNAL_API_KEY || '').trim();
  if (!tweetGenieUrl || !internalApiKey) return { status: 'skipped_not_configured' };

  try {
    const { response, body } = await postInternalJson({
      endpoint: buildInternalServiceEndpoint(tweetGenieUrl, '/api/internal/twitter/cross-post'),
      userId,
      teamId,
      internalApiKey,
      timeoutMs: X_CROSSPOST_TIMEOUT_MS,
      payload: {
        postMode: 'single',
        content,
        mediaDetected: Boolean(mediaDetected),
        sourcePlatform: 'threads_schedule',
        media: absolutizeSocialMediaUrlsForCrossPost(mediaUrls),
        ...(targetAccountId ? { targetAccountId: String(targetAccountId) } : {}),
      },
    });

    if (!response.ok) {
      if (response.status === 404 && String(body?.code || '').toUpperCase().includes('NOT_CONNECTED')) return { status: 'not_connected' };
      if (response.status === 401 && String(body?.code || '').toUpperCase().includes('TOKEN_EXPIRED')) return { status: 'not_connected' };
      if (response.status === 400 && String(body?.code || '').toUpperCase() === 'X_POST_TOO_LONG') return { status: 'failed_too_long' };
      return {
        status: 'failed',
        mediaStatus: typeof body?.mediaStatus === 'string' ? body.mediaStatus : undefined,
        mediaCount: Number.isFinite(Number(body?.mediaCount)) ? Number(body.mediaCount) : undefined,
      };
    }

    return {
      status: body?.status || 'posted',
      tweetId: body?.tweetId || null,
      tweetUrl: body?.tweetUrl || null,
      mediaDetected: Boolean(mediaDetected),
      mediaStatus: typeof body?.mediaStatus === 'string' ? body.mediaStatus : (mediaDetected ? 'posted' : 'none'),
      mediaCount: Number.isFinite(Number(body?.mediaCount)) ? Number(body.mediaCount) : (mediaDetected ? undefined : 0),
    };
  } catch (error) {
    if (error?.name === 'AbortError') return { status: 'timeout' };
    logger.warn('Threads scheduled X cross-post failed', { userId, error: error?.message || String(error) });
    return { status: 'failed' };
  }
};

const saveToTweetHistory = async ({ userId, teamId = null, content, tweetId = null, mediaDetected = false }) => {
  const tweetGenieUrl = String(process.env.TWEET_GENIE_URL || '').trim();
  const internalApiKey = String(process.env.INTERNAL_API_KEY || '').trim();
  if (!tweetGenieUrl || !internalApiKey) return;

  try {
    await postInternalJson({
      endpoint: buildInternalServiceEndpoint(tweetGenieUrl, '/api/internal/twitter/save-to-history'),
      userId,
      teamId,
      internalApiKey,
      payload: {
        content,
        tweetId,
        sourcePlatform: 'threads_schedule',
        mediaDetected: Boolean(mediaDetected),
      },
    });
  } catch {
    // Non-blocking history write
  }
};

const crossPostToLinkedIn = async ({ userId, teamId = null, content, mediaUrls = [], targetAccountId = null }) => {
  const linkedInGenieUrl = String(process.env.LINKEDIN_GENIE_URL || '').trim();
  const internalApiKey = String(process.env.INTERNAL_API_KEY || '').trim();
  if (!linkedInGenieUrl || !internalApiKey) return { status: 'skipped_not_configured' };

  try {
    const { response, body } = await postInternalJson({
      endpoint: buildInternalServiceEndpoint(linkedInGenieUrl, '/api/internal/cross-post'),
      userId,
      teamId,
      internalApiKey,
      timeoutMs: LINKEDIN_CROSSPOST_TIMEOUT_MS,
      payload: {
        content,
        media: absolutizeSocialMediaUrlsForCrossPost(mediaUrls),
        sourcePlatform: 'threads_schedule',
        ...(teamId && targetAccountId ? { targetLinkedinTeamAccountId: String(targetAccountId) } : {}),
      },
    });

    if (!response.ok) {
      if (response.status === 404 && String(body?.code || '').toUpperCase().includes('NOT_CONNECTED')) return { status: 'not_connected' };
      if (response.status === 401 && String(body?.code || '').toUpperCase().includes('TOKEN_EXPIRED')) return { status: 'not_connected' };
      return {
        status: 'failed',
        mediaStatus: typeof body?.mediaStatus === 'string' ? body.mediaStatus : undefined,
        mediaCount: Number.isFinite(Number(body?.mediaCount)) ? Number(body.mediaCount) : undefined,
      };
    }

    return {
      status: 'posted',
      linkedinPostId: body?.linkedinPostId || null,
      mediaStatus: typeof body?.mediaStatus === 'string' ? body.mediaStatus : 'none',
      mediaCount: Number.isFinite(Number(body?.mediaCount)) ? Number(body.mediaCount) : 0,
    };
  } catch (error) {
    if (error?.name === 'AbortError') return { status: 'timeout' };
    logger.warn('Threads scheduled LinkedIn cross-post failed', { userId, error: error?.message || String(error) });
    return { status: 'failed' };
  }
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

const markPosted = async ({ postId, instagramPostId, youtubeVideoId, threadsPostId, threadsSequence = null, metadata = undefined }) => {
  const canWriteMetadata = (await ensureMetadataColumnSupport()) && metadata !== undefined;

  if (canWriteMetadata) {
    await query(
      `UPDATE social_posts
       SET status = 'posted',
           posted_at = NOW(),
           instagram_post_id = COALESCE($2, instagram_post_id),
           youtube_video_id = COALESCE($3, youtube_video_id),
           threads_post_id = COALESCE($4, threads_post_id),
           threads_sequence = COALESCE($5::jsonb, threads_sequence),
           metadata = $6::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [postId, instagramPostId, youtubeVideoId, threadsPostId, threadsSequence, JSON.stringify(metadata || {})]
    );
    return;
  }

  await query(
    `UPDATE social_posts
     SET status = 'posted',
         posted_at = NOW(),
         instagram_post_id = COALESCE($2, instagram_post_id),
         youtube_video_id = COALESCE($3, youtube_video_id),
         threads_post_id = COALESCE($4, threads_post_id),
         threads_sequence = COALESCE($5::jsonb, threads_sequence),
         updated_at = NOW()
     WHERE id = $1`,
    [postId, instagramPostId, youtubeVideoId, threadsPostId, threadsSequence]
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
  let threadPostIds = [];

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
          threadPostIds = Array.isArray(publishResult.threadPostIds)
            ? publishResult.threadPostIds.map((id) => String(id || '').trim()).filter(Boolean)
            : [];
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

  const baseMetadata = parseJsonObject(post?.metadata, {});
  const crossPostMeta =
    baseMetadata?.cross_post && typeof baseMetadata.cross_post === 'object'
      ? { ...baseMetadata.cross_post }
      : null;
  let nextMetadata = baseMetadata;

  if (crossPostMeta && platforms.includes('threads')) {
    const targets =
      crossPostMeta.targets && typeof crossPostMeta.targets === 'object'
        ? crossPostMeta.targets
        : {};
    const xEnabled = Boolean(targets.x || targets.twitter);
    const linkedinEnabled = Boolean(targets.linkedin || targets.linkedIn);
    const mediaDetected = detectMedia(mediaUrls);
    const crossPostResult = {
      x: {
        enabled: xEnabled,
        status: xEnabled ? null : 'disabled',
        mediaDetected: Boolean(mediaDetected),
        mediaStatus: mediaDetected ? 'text_only_phase1' : 'none',
      },
      linkedin: {
        enabled: linkedinEnabled,
        status: linkedinEnabled ? null : 'disabled',
        mediaDetected: Boolean(mediaDetected),
        mediaStatus: mediaDetected ? 'text_only_phase1' : 'none',
      },
    };

    if (xEnabled || linkedinEnabled) {
      const sourceContent = caption || threadsSequence[0] || '';
      const routing =
        crossPostMeta.routing && typeof crossPostMeta.routing === 'object'
          ? crossPostMeta.routing
          : {};

      if (xEnabled) {
        const xResult = await crossPostToX({
          userId: post.user_id,
          teamId: post.team_id || null,
          content: sourceContent,
          mediaDetected,
          mediaUrls,
          targetAccountId: routing.x?.targetAccountId || null,
        });
        crossPostResult.x = {
          ...crossPostResult.x,
          ...xResult,
          status: xResult?.status || 'failed',
        };
        if (crossPostResult.x.status === 'posted') {
          await saveToTweetHistory({
            userId: post.user_id,
            teamId: post.team_id || null,
            content: sourceContent,
            tweetId: crossPostResult.x.tweetId || null,
            mediaDetected,
          });
        }
      }

      if (linkedinEnabled) {
        const linkedInResult = await crossPostToLinkedIn({
          userId: post.user_id,
          teamId: post.team_id || null,
          content: sourceContent,
          mediaUrls,
          targetAccountId: routing.linkedin?.targetAccountId || null,
        });
        crossPostResult.linkedin = {
          ...crossPostResult.linkedin,
          ...linkedInResult,
          status: linkedInResult?.status || 'failed',
        };
      }
    }

    crossPostMeta.last_attempted_at = new Date().toISOString();
    crossPostMeta.last_result = crossPostResult;
    nextMetadata = {
      ...baseMetadata,
      cross_post: crossPostMeta,
    };
  }

  await markPosted({
    postId: post.id,
    instagramPostId,
    youtubeVideoId,
    threadsPostId,
    threadsSequence: threadPostIds.length > 0 ? JSON.stringify(threadPostIds) : null,
    metadata: nextMetadata,
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
    const message = error?.message || String(error);
    if (isTransientDbError(error)) {
      logger.warn('Scheduled worker tick skipped due to transient DB connectivity issue', { message });
    } else {
      logger.error('Scheduled worker tick failed', { message });
    }
  } finally {
    isRunning = false;
  }
};

export const runSchedulerTick = async () => {
  return tick();
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
