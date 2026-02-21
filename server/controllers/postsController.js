import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { TeamCreditService } from '../services/teamCreditService.js';
import { publishInstagramPost } from '../services/instagramService.js';
import { publishThreadsPost, publishThreadsThread, deleteThreadsPosts } from '../services/threadsService.js';
import { publishYoutubeVideo } from '../services/youtubeService.js';
import { mapSocialPublishError } from '../utils/publishErrors.js';

const SUPPORTED_PLATFORMS = new Set(['instagram', 'youtube', 'threads']);
const PLATFORM_CAPTION_LIMITS = {
  instagram: Math.max(120, Number.parseInt(process.env.INSTAGRAM_CAPTION_MAX_CHARS || '2200', 10)),
  threads: Math.max(120, Number.parseInt(process.env.THREADS_TEXT_MAX_CHARS || '500', 10)),
  youtube: Math.max(120, Number.parseInt(process.env.YOUTUBE_CAPTION_MAX_CHARS || '5000', 10)),
};
const THREADS_AUTO_SPLIT_MAX_CHARS = Math.max(
  PLATFORM_CAPTION_LIMITS.threads,
  Number.parseInt(process.env.THREADS_AUTO_SPLIT_MAX_CHARS || '10000', 10)
);
const THREADS_MAX_CHAIN_POSTS = Math.max(2, Number.parseInt(process.env.THREADS_MAX_CHAIN_POSTS || '30', 10));
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mpeg', '.mpg']);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createHttpError = (status, message, code = null) => {
  const error = new Error(message);
  error.status = status;
  if (code) {
    error.code = code;
  }
  return error;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientDbConnectionError = (error) => {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();

  if (['57P01', '57P02', '57P03', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code)) {
    return true;
  }

  return (
    message.includes('connection terminated unexpectedly') ||
    message.includes('connection terminated due to connection timeout') ||
    message.includes('connection reset by peer') ||
    message.includes('terminating connection due to administrator command')
  );
};

const queryWithSingleRetry = async (text, params = []) => {
  try {
    return await query(text, params);
  } catch (error) {
    if (!isTransientDbConnectionError(error)) {
      throw error;
    }

    await sleep(120);
    return query(text, params);
  }
};

const resolveCaptionLimit = (platforms = []) => {
  const limits = platforms
    .map((platform) => PLATFORM_CAPTION_LIMITS[platform])
    .filter((value) => Number.isFinite(value) && value > 0);

  if (limits.length === 0) {
    return Math.max(120, Number.parseInt(process.env.AI_CAPTION_MAX_CHARS || '500', 10));
  }

  return Math.max(120, Math.min(...limits));
};

const resolveContextParams = (req) => {
  const userId = req.user.id;
  const { teamId, isTeamMember } = req.teamContext || {};

  return {
    userId,
    teamId: isTeamMember ? teamId : null,
    isTeamMember: Boolean(isTeamMember),
  };
};

const resolveUserToken = (req) => {
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return req.platformAccessToken || bearerToken || req.cookies?.accessToken || null;
};

const ensureConnectedPlatforms = async ({ userId, teamId, isTeamMember, platforms }) => {
  const baseQuery = isTeamMember && teamId
    ? `SELECT platform FROM social_connected_accounts WHERE team_id = $1 AND is_active = true AND platform = ANY($2::text[])`
    : `SELECT platform FROM social_connected_accounts WHERE user_id = $1 AND team_id IS NULL AND is_active = true AND platform = ANY($2::text[])`;

  const baseParams = isTeamMember && teamId ? [teamId, platforms] : [userId, platforms];
  const result = await query(baseQuery, baseParams);
  const connected = new Set(result.rows.map((row) => row.platform));
  const missing = platforms.filter((platform) => !connected.has(platform));
  return missing;
};

const getConnectedAccountByPlatform = async ({ userId, teamId, isTeamMember, platform }) => {
  const result = isTeamMember && teamId
    ? await query(
        `SELECT id, account_id, account_username, account_display_name, access_token, refresh_token, token_expires_at, metadata
         FROM social_connected_accounts
         WHERE team_id = $1 AND platform = $2 AND is_active = true
         ORDER BY updated_at DESC
         LIMIT 1`,
        [teamId, platform]
      )
    : await query(
        `SELECT id, account_id, account_username, account_display_name, access_token, refresh_token, token_expires_at, metadata
         FROM social_connected_accounts
         WHERE user_id = $1 AND team_id IS NULL AND platform = $2 AND is_active = true
         ORDER BY updated_at DESC
         LIMIT 1`,
        [userId, platform]
      );

  return result.rows[0] || null;
};

const getRequestHost = (req) => {
  const forwardedHost = req.headers['x-forwarded-host'];
  if (forwardedHost) {
    return String(forwardedHost).split(',')[0].trim();
  }
  return req.get('host') || null;
};

const normalizeThreadsPosts = (input) => {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => String(item || '').trim())
    .filter(Boolean);
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

const looksLikeThreadsPostId = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  return /^[0-9_]+$/.test(normalized) && normalized.length >= 6;
};

const collectThreadsDeletionIds = (post) => {
  const ids = [];

  const primaryId = String(post?.threads_post_id || '').trim();
  if (looksLikeThreadsPostId(primaryId)) {
    ids.push(primaryId);
  }

  for (const item of parseJsonArray(post?.threads_sequence)) {
    const candidate = String(item || '').trim();
    if (looksLikeThreadsPostId(candidate)) {
      ids.push(candidate);
    }
  }

  return [...new Set(ids)];
};

const isVideoMediaUrl = (value) => {
  try {
    const url = String(value || '').trim();
    if (!url) return false;
    const parsed = url.startsWith('http://') || url.startsWith('https://')
      ? new URL(url)
      : new URL(`https://dummy.local${url.startsWith('/') ? '' : '/'}${url}`);
    const path = parsed.pathname.toLowerCase();
    return Array.from(VIDEO_EXTENSIONS).some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
};

const hasAtLeastOneVideoMedia = (mediaUrls = []) =>
  Array.isArray(mediaUrls) && mediaUrls.some((value) => isVideoMediaUrl(String(value || '').trim()));

const inferThreadsContentType = (selectedType, mediaUrls = []) => {
  const normalized = String(selectedType || 'text').toLowerCase();
  if (normalized === 'thread' || normalized === 'image' || normalized === 'video') {
    return normalized;
  }

  if (Array.isArray(mediaUrls) && mediaUrls.length > 0) {
    return isVideoMediaUrl(mediaUrls[0]) ? 'video' : 'image';
  }

  return 'text';
};

const splitThreadsCaption = (text, limit = PLATFORM_CAPTION_LIMITS.threads, maxPosts = THREADS_MAX_CHAIN_POSTS) => {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) return [];
  if (normalized.length <= limit) return [normalized];

  const posts = [];
  let remaining = normalized;
  const softFloor = Math.floor(limit * 0.55);

  while (remaining.length > limit && posts.length < maxPosts - 1) {
    const slice = remaining.slice(0, limit + 1);
    let cut = -1;

    const newlineCut = slice.lastIndexOf('\n');
    if (newlineCut >= softFloor) {
      cut = newlineCut;
    }

    if (cut < softFloor) {
      const sentenceCut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      if (sentenceCut >= softFloor) {
        cut = sentenceCut + 1;
      }
    }

    if (cut < softFloor) {
      const spaceCut = slice.lastIndexOf(' ');
      if (spaceCut >= softFloor) {
        cut = spaceCut;
      }
    }

    if (cut < softFloor) {
      cut = limit;
    }

    const part = remaining.slice(0, cut).trim();
    if (part) {
      posts.push(part);
    }
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    posts.push(remaining);
  }

  if (posts.length > maxPosts) {
    throw createHttpError(
      400,
      `Caption is too long for auto thread split (max ${maxPosts} posts).`,
      'THREADS_CHAIN_TOO_LONG'
    );
  }

  return posts;
};

const buildOwnershipClause = ({ isTeamMember, teamId, userId, startIndex = 1 }) => {
  if (isTeamMember && teamId) {
    return {
      clause: `team_id = $${startIndex}`,
      params: [teamId],
    };
  }

  return {
    clause: `user_id = $${startIndex} AND team_id IS NULL`,
    params: [userId],
  };
};

export const createPost = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = resolveContextParams(req);

    const {
      caption,
      mediaUrls = [],
      platforms = [],
      crossPost = false,
      instagramContentType = 'feed',
      youtubeContentType = 'video',
      threadsContentType = 'text',
      threadsPosts = [],
      postNow = true,
      scheduledFor = null,
    } = req.body || {};

    const normalizedPlatforms = Array.isArray(platforms)
      ? [...new Set(platforms.map((platform) => String(platform).toLowerCase()))]
      : [];

    if (normalizedPlatforms.length === 0) {
      return res.status(400).json({ error: 'At least one platform is required' });
    }

    const unsupported = normalizedPlatforms.filter((platform) => !SUPPORTED_PLATFORMS.has(platform));
    if (unsupported.length > 0) {
      return res.status(400).json({ error: `Unsupported platforms: ${unsupported.join(', ')}` });
    }

    const normalizedCaption = String(caption || '').trim();
    const normalizedThreadsPosts = normalizeThreadsPosts(threadsPosts);
    const threadsSelected = normalizedPlatforms.includes('threads');
    const requestedThreadsType = String(threadsContentType || 'text').toLowerCase();
    const inferredThreadsType = threadsSelected
      ? inferThreadsContentType(requestedThreadsType, mediaUrls)
      : requestedThreadsType;
    const shouldAutoSplitThreads =
      threadsSelected &&
      inferredThreadsType === 'text' &&
      normalizedCaption.length > PLATFORM_CAPTION_LIMITS.threads;
    const isThreadsThread =
      threadsSelected && (requestedThreadsType === 'thread' || shouldAutoSplitThreads);
    const effectiveThreadsType = isThreadsThread ? 'thread' : inferredThreadsType;
    let effectiveThreadsPosts = requestedThreadsType === 'thread' ? normalizedThreadsPosts : [];
    if (requestedThreadsType !== 'thread' && shouldAutoSplitThreads) {
      try {
        effectiveThreadsPosts = splitThreadsCaption(
          normalizedCaption,
          PLATFORM_CAPTION_LIMITS.threads,
          THREADS_MAX_CHAIN_POSTS
        );
      } catch (error) {
        pushIssue('threads', error.code || 'THREADS_CHAIN_TOO_LONG', error.message);
      }
    }
    const captionTargetPlatforms = normalizedPlatforms.filter(
      (platform) => !(platform === 'threads' && isThreadsThread)
    );
    const baseCaptionLimit = resolveCaptionLimit(captionTargetPlatforms);
    const captionMaxChars =
      captionTargetPlatforms.length === 0 && isThreadsThread
        ? THREADS_AUTO_SPLIT_MAX_CHARS
        : baseCaptionLimit;

    if (normalizedPlatforms.some((platform) => platform === 'instagram' || platform === 'youtube') && !normalizedCaption) {
      return res.status(400).json({ error: 'Caption is required for Instagram/YouTube posts' });
    }

    if (!isThreadsThread && !normalizedCaption) {
      return res.status(400).json({ error: 'Caption is required' });
    }

    if (isThreadsThread && effectiveThreadsPosts.length < 2) {
      return res.status(400).json({
        error: 'Threads chain mode requires at least 2 posts',
        code: 'THREADS_CHAIN_MIN_POSTS',
      });
    }

    if (normalizedCaption && normalizedCaption.length > captionMaxChars) {
      return res.status(400).json({
        error: `Caption is too long. Max ${captionMaxChars} characters for selected platforms.`,
        code: 'CAPTION_TOO_LONG',
      });
    }

    if (isThreadsThread) {
      const threadsLimit = PLATFORM_CAPTION_LIMITS.threads;
      const tooLong = effectiveThreadsPosts.find((post) => post.length > threadsLimit);
      if (tooLong) {
        return res.status(400).json({
          error: `Each thread post must be ${threadsLimit} characters or fewer.`,
          code: 'THREADS_POST_TOO_LONG',
        });
      }
    }

    if (!postNow && !scheduledFor) {
      return res.status(400).json({ error: 'scheduledFor is required when scheduling a post' });
    }

    const missingConnections = await ensureConnectedPlatforms({
      userId,
      teamId,
      isTeamMember,
      platforms: normalizedPlatforms,
    });

    if (missingConnections.length > 0) {
      return res.status(400).json({
        error: `Connect accounts before posting: ${missingConnections.join(', ')}`,
        code: 'MISSING_CONNECTED_ACCOUNT',
      });
    }

    let instagramAccount = null;
    if (normalizedPlatforms.includes('instagram')) {
      instagramAccount = await getConnectedAccountByPlatform({
        userId,
        teamId,
        isTeamMember,
        platform: 'instagram',
      });

      if (!instagramAccount?.access_token || !instagramAccount?.account_id) {
        return res.status(400).json({
          error: 'Instagram account is connected but missing token/account details. Reconnect Instagram.',
          code: 'INSTAGRAM_TOKEN_MISSING',
        });
      }

      if (
        instagramAccount.token_expires_at &&
        new Date(instagramAccount.token_expires_at).getTime() <= Date.now()
      ) {
        return res.status(400).json({
          error: 'Instagram token has expired. Reconnect your Instagram account.',
          code: 'INSTAGRAM_TOKEN_EXPIRED',
        });
      }
    }

    let threadsAccount = null;
    if (normalizedPlatforms.includes('threads')) {
      threadsAccount = await getConnectedAccountByPlatform({
        userId,
        teamId,
        isTeamMember,
        platform: 'threads',
      });

      if (!threadsAccount?.access_token || !threadsAccount?.account_id) {
        return res.status(400).json({
          error: 'Threads account is connected but missing token/account details. Reconnect Threads.',
          code: 'THREADS_TOKEN_MISSING',
        });
      }

      if (
        threadsAccount.token_expires_at &&
        new Date(threadsAccount.token_expires_at).getTime() <= Date.now()
      ) {
        return res.status(400).json({
          error: 'Threads token has expired. Reconnect your Threads account.',
          code: 'THREADS_TOKEN_EXPIRED',
        });
      }
    }

    let youtubeAccount = null;
    if (normalizedPlatforms.includes('youtube')) {
      youtubeAccount = await getConnectedAccountByPlatform({
        userId,
        teamId,
        isTeamMember,
        platform: 'youtube',
      });

      if (!youtubeAccount?.access_token || !youtubeAccount?.account_id) {
        return res.status(400).json({
          error: 'YouTube account is connected but missing token/account details. Reconnect YouTube.',
          code: 'YOUTUBE_TOKEN_MISSING',
        });
      }

      const youtubeTokenExpired =
        youtubeAccount.token_expires_at &&
        new Date(youtubeAccount.token_expires_at).getTime() <= Date.now();
      const hasRefreshToken = Boolean(String(youtubeAccount.refresh_token || '').trim());
      if (youtubeTokenExpired && !hasRefreshToken) {
        return res.status(400).json({
          error: 'YouTube token has expired. Reconnect your YouTube account.',
          code: 'YOUTUBE_TOKEN_EXPIRED',
        });
      }

      if (!hasAtLeastOneVideoMedia(mediaUrls)) {
        return res.status(400).json({
          error: 'YouTube posts require at least one uploaded video file (.mp4/.mov/.webm).',
          code: 'YOUTUBE_VIDEO_REQUIRED',
        });
      }
    }

    const userToken = resolveUserToken(req);
    const creditOperation = postNow ? 'social_post_create' : 'social_post_schedule';
    const creditCost = TeamCreditService.calculateCost(creditOperation, {
      platformCount: normalizedPlatforms.length,
      crossPost: Boolean(crossPost),
    });

    let creditMeta = {
      creditsUsed: 0,
      creditSource: isTeamMember && teamId ? 'team' : 'user',
      creditsRemaining: null,
    };
    let creditsDeducted = false;

    if (creditCost > 0) {
      const creditCheck = await TeamCreditService.checkCredits(userId, teamId, creditCost, userToken);
      if (!creditCheck.success) {
        return res.status(402).json({
          error: 'Insufficient credits',
          creditsRequired: creditCost,
          creditsAvailable: creditCheck.available ?? creditCheck.creditsAvailable ?? 0,
          creditSource: creditCheck.source || (isTeamMember && teamId ? 'team' : 'user'),
        });
      }

      const deductResult = await TeamCreditService.deductCredits(
        userId,
        teamId,
        creditCost,
        creditOperation,
        userToken,
        {
          description: `${postNow ? 'Post now' : 'Schedule post'} (${normalizedPlatforms.join(', ')})`,
        }
      );

      if (!deductResult.success) {
        return res.status(402).json({
          error: deductResult.error || 'Failed to deduct credits',
          creditsRequired: creditCost,
          creditsAvailable: deductResult.available ?? deductResult.creditsAvailable ?? 0,
          creditSource: deductResult.source || (isTeamMember && teamId ? 'team' : 'user'),
        });
      }

      creditsDeducted = true;
      creditMeta = {
        creditsUsed: creditCost,
        creditSource: deductResult.source || (isTeamMember && teamId ? 'team' : 'user'),
        creditsRemaining: deductResult.remainingCredits ?? null,
      };
    }

    const status = postNow ? 'posted' : 'scheduled';
    const nowIso = new Date().toISOString();
    const scheduledIso = postNow ? null : new Date(scheduledFor).toISOString();
    const metrics = {
      instagram_likes: 0,
      instagram_comments: 0,
      instagram_reach: 0,
      youtube_views: 0,
      youtube_watch_time_minutes: 0,
      youtube_subscribers_gained: 0,
      threads_likes: 0,
      threads_replies: 0,
      threads_views: 0,
    };

    const id = uuidv4();
    const effectiveCaption = normalizedCaption || effectiveThreadsPosts[0] || '';
    let instagramPostId = null;
    let youtubeVideoId = null;
    let threadsPostId = null;
    let threadPostIds = [];

    try {
      if (postNow && normalizedPlatforms.includes('instagram')) {
        try {
          if (!Array.isArray(mediaUrls) || mediaUrls.length === 0) {
            throw createHttpError(400, 'Instagram posting requires at least one uploaded media file', 'INSTAGRAM_MEDIA_REQUIRED');
          }

          const publishResult = await publishInstagramPost({
            accountId: instagramAccount.account_id,
            accessToken: instagramAccount.access_token,
            mediaUrls,
            caption: effectiveCaption,
            contentType: instagramContentType,
            requestHost: getRequestHost(req),
          });

          instagramPostId = publishResult.publishId || publishResult.creationId || null;
        } catch (platformError) {
          platformError.publishPlatform = 'instagram';
          throw platformError;
        }
      }

      if (postNow && normalizedPlatforms.includes('threads')) {
        try {
          if (isThreadsThread) {
            const publishResult = await publishThreadsThread({
              accountId: threadsAccount.account_id,
              accessToken: threadsAccount.access_token,
              posts: effectiveThreadsPosts,
            });
            threadsPostId = publishResult.publishId || null;
            threadPostIds = Array.isArray(publishResult.threadPostIds) ? publishResult.threadPostIds : [];
          } else {
            const publishResult = await publishThreadsPost({
              accountId: threadsAccount.account_id,
              accessToken: threadsAccount.access_token,
              text: effectiveCaption,
              mediaUrls,
              contentType: effectiveThreadsType,
              requestHost: getRequestHost(req),
            });

            threadsPostId = publishResult.publishId || publishResult.creationId || null;
          }
        } catch (platformError) {
          platformError.publishPlatform = 'threads';
          throw platformError;
        }
      }

      if (postNow && normalizedPlatforms.includes('youtube')) {
        try {
          const publishResult = await publishYoutubeVideo({
            connection: youtubeAccount,
            mediaUrls,
            caption: effectiveCaption,
            contentType: youtubeContentType,
          });

          youtubeVideoId = publishResult.videoId || null;
          if (!youtubeVideoId) {
            throw createHttpError(400, 'YouTube upload did not return a video ID', 'YOUTUBE_UPLOAD_NO_VIDEO_ID');
          }
        } catch (platformError) {
          platformError.publishPlatform = 'youtube';
          throw platformError;
        }
      }

      await query(
        `INSERT INTO social_posts (
           id, user_id, team_id, caption, media_urls, platforms, cross_post,
           instagram_content_type, youtube_content_type, threads_content_type,
           status, scheduled_for, posted_at,
           instagram_post_id, youtube_video_id, threads_post_id, threads_sequence,
           instagram_likes, instagram_comments, instagram_reach,
           youtube_views, youtube_watch_time_minutes, youtube_subscribers_gained,
           threads_likes, threads_replies, threads_views
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7,
           $8, $9, $10,
           $11, $12, $13,
           $14, $15, $16, $17::jsonb,
           $18, $19, $20,
           $21, $22, $23,
           $24, $25, $26
         )`,
        [
          id,
          userId,
          teamId,
          effectiveCaption,
          JSON.stringify(mediaUrls || []),
          JSON.stringify(normalizedPlatforms),
          Boolean(crossPost),
          instagramContentType,
          youtubeContentType,
          effectiveThreadsType,
          status,
          scheduledIso,
          postNow ? nowIso : null,
          instagramPostId,
          youtubeVideoId,
          threadsPostId,
          JSON.stringify(isThreadsThread && !postNow ? effectiveThreadsPosts : threadPostIds),
          metrics.instagram_likes,
          metrics.instagram_comments,
          metrics.instagram_reach,
          metrics.youtube_views,
          metrics.youtube_watch_time_minutes,
          metrics.youtube_subscribers_gained,
          metrics.threads_likes,
          metrics.threads_replies,
          metrics.threads_views,
        ]
      );
    } catch (operationError) {
      if (creditsDeducted && creditMeta.creditsUsed > 0) {
        await TeamCreditService.refundCredits(
          userId,
          teamId,
          creditMeta.creditsUsed,
          'social_post_create_failed',
          userToken,
          {
            description: 'Refund for failed post creation',
          }
        ).catch(() => null);
      }

      const mappedPublishError = mapSocialPublishError(operationError, {
        platform: operationError?.publishPlatform || null,
      });
      if (mappedPublishError) {
        throw mappedPublishError;
      }

      throw operationError;
    }

    const created = await query('SELECT * FROM social_posts WHERE id = $1', [id]);
    return res.status(201).json({
      success: true,
      post: created.rows[0],
      creditsUsed: creditMeta.creditsUsed,
      creditSource: creditMeta.creditSource,
      creditsRemaining: creditMeta.creditsRemaining,
    });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    return res.status(status).json({
      error: status === 500 ? 'Failed to create post' : error.message,
      code: error.code || null,
      details: status === 500 ? error.message : undefined,
    });
  }
};

export const preflightPost = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = resolveContextParams(req);
    const {
      caption,
      mediaUrls = [],
      platforms = [],
      threadsContentType = 'text',
      threadsPosts = [],
    } = req.body || {};

    const normalizedPlatforms = Array.isArray(platforms)
      ? [...new Set(platforms.map((platform) => String(platform).toLowerCase()))]
      : [];

    if (normalizedPlatforms.length === 0) {
      return res.status(400).json({ error: 'At least one platform is required', code: 'PLATFORM_REQUIRED' });
    }

    const unsupported = normalizedPlatforms.filter((platform) => !SUPPORTED_PLATFORMS.has(platform));
    if (unsupported.length > 0) {
      return res.status(400).json({ error: `Unsupported platforms: ${unsupported.join(', ')}`, code: 'PLATFORM_UNSUPPORTED' });
    }

    const issues = [];
    const pushIssue = (platform, code, message) => {
      issues.push({ platform, code, message, severity: 'error' });
    };

    const normalizedCaption = String(caption || '').trim();
    const normalizedThreadsPosts = normalizeThreadsPosts(threadsPosts);
    const threadsSelected = normalizedPlatforms.includes('threads');
    const requestedThreadsType = String(threadsContentType || 'text').toLowerCase();
    const inferredThreadsType = threadsSelected
      ? inferThreadsContentType(requestedThreadsType, mediaUrls)
      : requestedThreadsType;
    const shouldAutoSplitThreads =
      threadsSelected &&
      inferredThreadsType === 'text' &&
      normalizedCaption.length > PLATFORM_CAPTION_LIMITS.threads;
    const isThreadsThread =
      threadsSelected && (requestedThreadsType === 'thread' || shouldAutoSplitThreads);
    const effectiveThreadsType = isThreadsThread ? 'thread' : inferredThreadsType;
    const effectiveThreadsPosts = requestedThreadsType === 'thread'
      ? normalizedThreadsPosts
      : (shouldAutoSplitThreads
        ? splitThreadsCaption(normalizedCaption, PLATFORM_CAPTION_LIMITS.threads, THREADS_MAX_CHAIN_POSTS)
        : []);

    const captionTargetPlatforms = normalizedPlatforms.filter(
      (platform) => !(platform === 'threads' && isThreadsThread)
    );
    const baseCaptionLimit = resolveCaptionLimit(captionTargetPlatforms);
    const captionMaxChars =
      captionTargetPlatforms.length === 0 && isThreadsThread
        ? THREADS_AUTO_SPLIT_MAX_CHARS
        : baseCaptionLimit;

    if (normalizedPlatforms.some((platform) => platform === 'instagram' || platform === 'youtube') && !normalizedCaption) {
      pushIssue('content', 'CAPTION_REQUIRED', 'Caption is required for Instagram/YouTube posts.');
    }

    if (!isThreadsThread && !normalizedCaption) {
      pushIssue('threads', 'CAPTION_REQUIRED', 'Caption/Text is required.');
    }

    if (isThreadsThread && effectiveThreadsPosts.length < 2) {
      pushIssue('threads', 'THREADS_CHAIN_MIN_POSTS', 'Threads chain mode requires at least 2 posts.');
    }

    if (normalizedCaption && normalizedCaption.length > captionMaxChars) {
      pushIssue('content', 'CAPTION_TOO_LONG', `Caption is too long. Max ${captionMaxChars} characters for selected platforms.`);
    }

    if (isThreadsThread) {
      const tooLong = effectiveThreadsPosts.find((post) => post.length > PLATFORM_CAPTION_LIMITS.threads);
      if (tooLong) {
        pushIssue(
          'threads',
          'THREADS_POST_TOO_LONG',
          `Each thread post must be ${PLATFORM_CAPTION_LIMITS.threads} characters or fewer.`
        );
      }
    }

    if (normalizedPlatforms.includes('instagram') && (!Array.isArray(mediaUrls) || mediaUrls.length === 0)) {
      pushIssue('instagram', 'INSTAGRAM_MEDIA_REQUIRED', 'Instagram posting requires at least one uploaded media file.');
    }

    if (
      threadsSelected &&
      !isThreadsThread &&
      ['image', 'video'].includes(effectiveThreadsType) &&
      (!Array.isArray(mediaUrls) || mediaUrls.length === 0)
    ) {
      pushIssue('threads', 'THREADS_MEDIA_REQUIRED', 'Threads image/video post requires uploaded media.');
    }

    if (normalizedPlatforms.includes('youtube') && !hasAtLeastOneVideoMedia(mediaUrls)) {
      pushIssue('youtube', 'YOUTUBE_VIDEO_REQUIRED', 'YouTube posts require at least one uploaded video file (.mp4/.mov/.webm).');
    }

    const missingConnections = await ensureConnectedPlatforms({
      userId,
      teamId,
      isTeamMember,
      platforms: normalizedPlatforms,
    });

    for (const platform of missingConnections) {
      pushIssue(platform, 'MISSING_CONNECTED_ACCOUNT', `Connect ${platform} before posting.`);
    }

    const shouldCheckPlatform = (platform) => normalizedPlatforms.includes(platform) && !missingConnections.includes(platform);

    if (shouldCheckPlatform('instagram')) {
      const instagramAccount = await getConnectedAccountByPlatform({
        userId,
        teamId,
        isTeamMember,
        platform: 'instagram',
      });

      if (!instagramAccount?.access_token || !instagramAccount?.account_id) {
        pushIssue('instagram', 'INSTAGRAM_TOKEN_MISSING', 'Instagram account is connected but missing token/account details.');
      } else if (
        instagramAccount.token_expires_at &&
        new Date(instagramAccount.token_expires_at).getTime() <= Date.now()
      ) {
        pushIssue('instagram', 'INSTAGRAM_TOKEN_EXPIRED', 'Instagram token has expired. Reconnect Instagram.');
      }
    }

    if (shouldCheckPlatform('threads')) {
      const threadsAccount = await getConnectedAccountByPlatform({
        userId,
        teamId,
        isTeamMember,
        platform: 'threads',
      });

      if (!threadsAccount?.access_token || !threadsAccount?.account_id) {
        pushIssue('threads', 'THREADS_TOKEN_MISSING', 'Threads account is connected but missing token/account details.');
      } else if (
        threadsAccount.token_expires_at &&
        new Date(threadsAccount.token_expires_at).getTime() <= Date.now()
      ) {
        pushIssue('threads', 'THREADS_TOKEN_EXPIRED', 'Threads token has expired. Reconnect Threads.');
      }
    }

    if (shouldCheckPlatform('youtube')) {
      const youtubeAccount = await getConnectedAccountByPlatform({
        userId,
        teamId,
        isTeamMember,
        platform: 'youtube',
      });

      if (!youtubeAccount?.access_token || !youtubeAccount?.account_id) {
        pushIssue('youtube', 'YOUTUBE_TOKEN_MISSING', 'YouTube account is connected but missing token/account details.');
      } else {
        const youtubeTokenExpired =
          youtubeAccount.token_expires_at &&
          new Date(youtubeAccount.token_expires_at).getTime() <= Date.now();
        const hasRefreshToken = Boolean(String(youtubeAccount.refresh_token || '').trim());
        if (youtubeTokenExpired && !hasRefreshToken) {
          pushIssue('youtube', 'YOUTUBE_TOKEN_EXPIRED', 'YouTube token has expired. Reconnect YouTube.');
        }
      }
    }

    return res.json({
      success: true,
      canPublish: issues.length === 0,
      issues,
      resolved: {
        platforms: normalizedPlatforms,
        threadsContentType: effectiveThreadsType,
        isThreadsThread,
        captionMaxChars,
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to run preflight checks',
      details: error.message,
    });
  }
};

export const listRecentPosts = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = resolveContextParams(req);
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit || '10', 10), 50));
    const { clause, params } = buildOwnershipClause({ isTeamMember, teamId, userId });

    const result = await query(
      `SELECT * FROM social_posts
       WHERE ${clause}
         AND status <> 'deleted'
       ORDER BY COALESCE(posted_at, scheduled_for, created_at) DESC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    return res.json({ success: true, posts: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch recent posts', details: error.message });
  }
};

export const listHistoryPosts = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = resolveContextParams(req);
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit || '50', 10), 200));
    const status = String(req.query.status || 'all').toLowerCase();
    const platform = String(req.query.platform || 'all').toLowerCase();
    const days = Number.parseInt(req.query.days || '0', 10);
    const sort = String(req.query.sort || 'newest').toLowerCase();
    const allowedStatuses = new Set(['all', 'posted', 'scheduled', 'failed', 'deleted']);
    const allowedPlatforms = new Set(['all', 'instagram', 'threads', 'youtube']);

    const normalizedStatus = allowedStatuses.has(status) ? status : 'all';
    const normalizedPlatform = allowedPlatforms.has(platform) ? platform : 'all';
    const normalizedDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 0;
    const sortDirection = sort === 'oldest' ? 'ASC' : 'DESC';

    const { clause, params } = buildOwnershipClause({ isTeamMember, teamId, userId });
    const filters = [clause];
    const queryParams = [...params];

    if (normalizedStatus !== 'all') {
      queryParams.push(normalizedStatus);
      filters.push(`status = $${queryParams.length}`);
    }

    if (normalizedPlatform !== 'all') {
      queryParams.push(normalizedPlatform);
      filters.push(`platforms ? $${queryParams.length}`);
    }

    if (normalizedDays > 0) {
      queryParams.push(String(normalizedDays));
      filters.push(`COALESCE(posted_at, scheduled_for, created_at) >= NOW() - ($${queryParams.length}::text || ' days')::interval`);
    }

    queryParams.push(limit);

    const result = await query(
      `SELECT *
       FROM social_posts
       WHERE ${filters.join(' AND ')}
       ORDER BY COALESCE(posted_at, scheduled_for, created_at) ${sortDirection}
       LIMIT $${queryParams.length}`,
      queryParams
    );

    return res.json({
      success: true,
      posts: result.rows,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch post history', details: error.message });
  }
};

export const deleteHistoryPost = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = resolveContextParams(req);
    const postId = String(req.params.postId || '').trim();

    if (!postId) {
      return res.status(400).json({ error: 'postId is required', code: 'POST_ID_REQUIRED' });
    }

    if (!UUID_V4_PATTERN.test(postId)) {
      return res.status(400).json({ error: 'Invalid postId format', code: 'POST_ID_INVALID' });
    }

    const { clause, params } = buildOwnershipClause({ isTeamMember, teamId, userId, startIndex: 2 });
    const lookup = await queryWithSingleRetry(
      `SELECT id, status, platforms, threads_post_id, threads_sequence
       FROM social_posts
       WHERE id = $1 AND ${clause}
       LIMIT 1`,
      [postId, ...params]
    );

    const found = lookup.rows[0];
    if (!found) {
      return res.status(404).json({ error: 'Post not found', code: 'POST_NOT_FOUND' });
    }

    const platforms = parseJsonArray(found.platforms).map((platform) => String(platform || '').toLowerCase());
    const hasThreads = platforms.includes('threads');
    const isAlreadyDeleted = found.status === 'deleted';
    const threadIds = hasThreads ? collectThreadsDeletionIds(found) : [];
    const shouldDeleteOnThreads = hasThreads && (
      found.status === 'posted' ||
      (isAlreadyDeleted && threadIds.length > 0)
    );

    if (shouldDeleteOnThreads) {
      const threadsAccount = await getConnectedAccountByPlatform({
        userId,
        teamId,
        isTeamMember,
        platform: 'threads',
      });

      if (!threadsAccount?.access_token) {
        return res.status(400).json({
          error: 'Threads account token is missing. Reconnect Threads before deleting published posts.',
          code: 'THREADS_TOKEN_MISSING',
        });
      }

      if (threadIds.length === 0) {
        return res.status(409).json({
          error: 'Threads post ID is missing for this item. Delete it manually on Threads, then retry history delete.',
          code: 'THREADS_DELETE_ID_MISSING',
        });
      }

      await deleteThreadsPosts({
        accessToken: threadsAccount.access_token,
        postIds: threadIds,
      });
    }

    if (isAlreadyDeleted) {
      return res.json({
        success: true,
        message: shouldDeleteOnThreads ? 'Post already deleted; Threads sync completed.' : 'Post already deleted',
      });
    }

    await queryWithSingleRetry(
      `UPDATE social_posts
       SET status = 'deleted',
           updated_at = NOW()
       WHERE id = $1`,
      [postId]
    );

    return res.json({ success: true, message: 'Post deleted' });
  } catch (error) {
    if (isTransientDbConnectionError(error)) {
      return res.status(503).json({
        error: 'Database connection was interrupted. Please retry delete.',
        code: 'DB_CONNECTION_INTERRUPTED',
      });
    }

    if (Number.isInteger(error.status)) {
      return res.status(error.status).json({
        error: error.message || 'Failed to delete post',
        code: error.code || null,
      });
    }

    return res.status(500).json({ error: 'Failed to delete post', details: error.message });
  }
};
