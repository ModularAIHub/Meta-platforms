import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { publishThreadsPost, publishThreadsThread } from '../services/threadsService.js';
import { uploadUrlToCloudinary, uploadBufferToCloudinary, isCloudinaryUrl } from '../utils/cloudinaryUpload.js';
import { logger } from '../utils/logger.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERNAL_CROSSPOST_MAX_MEDIA_ITEMS = 4;
const INTERNAL_CROSSPOST_MAX_MEDIA_BYTES = 8 * 1024 * 1024;

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
  next();
};

const resolvePlatformUserId = (req) => String(req.headers['x-platform-user-id'] || '').trim();
const resolvePlatformTeamId = (req) => String(req.headers['x-platform-team-id'] || '').trim() || null;

const getPersonalThreadsAccount = async (platformUserId) => {
  if (!platformUserId) return null;

  const result = await query(
    `SELECT id, user_id, account_id, account_username, access_token, token_expires_at, metadata
     FROM social_connected_accounts
     WHERE user_id = $1
       AND team_id IS NULL
       AND platform = 'threads'
       AND is_active = true
     ORDER BY updated_at DESC
     LIMIT 1`,
    [platformUserId]
  );

  return result.rows[0] || null;
};

const getPersonalThreadsAccountById = async (platformUserId, targetAccountId) => {
  if (!platformUserId || !targetAccountId) return null;

  const result = await query(
    `SELECT id, user_id, team_id, account_id, account_username, account_display_name, profile_image_url, access_token, token_expires_at, metadata
     FROM social_connected_accounts
     WHERE user_id = $1
       AND team_id IS NULL
       AND platform = 'threads'
       AND is_active = true
       AND id::text = $2::text
     LIMIT 1`,
    [platformUserId, String(targetAccountId)]
  );

  return result.rows[0] || null;
};

const getTeamThreadsAccountForMember = async (platformUserId, platformTeamId) => {
  if (!platformUserId || !platformTeamId) return null;

  const result = await query(
    `SELECT sca.id, sca.user_id, sca.team_id, sca.account_id, sca.account_username, sca.account_display_name,
            sca.profile_image_url, sca.access_token, sca.token_expires_at, sca.metadata
     FROM social_connected_accounts sca
     INNER JOIN team_members tm
       ON tm.team_id::text = sca.team_id::text
      AND tm.user_id = $1
      AND tm.status = 'active'
     WHERE sca.team_id::text = $2::text
       AND sca.platform = 'threads'
       AND sca.is_active = true
     ORDER BY sca.updated_at DESC NULLS LAST, sca.id DESC
     LIMIT 1`,
    [platformUserId, String(platformTeamId)]
  );

  return result.rows[0] || null;
};

const getTeamThreadsAccountForMemberById = async (platformUserId, platformTeamId, targetAccountId) => {
  if (!platformUserId || !platformTeamId || !targetAccountId) return null;

  const result = await query(
    `SELECT sca.id, sca.user_id, sca.team_id, sca.account_id, sca.account_username, sca.account_display_name,
            sca.profile_image_url, sca.access_token, sca.token_expires_at, sca.metadata
     FROM social_connected_accounts sca
     INNER JOIN team_members tm
       ON tm.team_id::text = sca.team_id::text
      AND tm.user_id = $1
      AND tm.status = 'active'
     WHERE sca.team_id::text = $2::text
       AND sca.platform = 'threads'
       AND sca.is_active = true
       AND sca.id::text = $3::text
     LIMIT 1`,
    [platformUserId, String(platformTeamId), String(targetAccountId)]
  );

  return result.rows[0] || null;
};

const isTokenExpired = (tokenExpiresAt) => {
  if (!tokenExpiresAt) return false;
  const expiresMs = new Date(tokenExpiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs <= Date.now();
};

const trimText = (value, maxLength = 5000) => String(value || '').trim().slice(0, maxLength);

const normalizeCrossPostMediaInputs = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, INTERNAL_CROSSPOST_MAX_MEDIA_ITEMS);
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

const parseDataUrl = (value) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;

  const mimetype = String(match[1] || '').toLowerCase();
  if (!mimetype.startsWith('image/') && !mimetype.startsWith('video/')) {
    return null;
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > INTERNAL_CROSSPOST_MAX_MEDIA_BYTES) {
    throw new Error(`Cross-post media exceeds ${INTERNAL_CROSSPOST_MAX_MEDIA_BYTES} bytes`);
  }

  const extMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
  };

  return {
    mimetype,
    buffer,
    extension: extMap[mimetype] || 'bin',
  };
};
const persistDataUrlMediaForThreads = async (value) => {
  const parsed = parseDataUrl(value);
  if (!parsed) return null;

  const uploaded = await uploadBufferToCloudinary(parsed.buffer, parsed.mimetype, 'threads');
  const url = uploaded.secure_url || uploaded.url;
  if (!url) throw new Error('Cloudinary upload returned no URL');

  return {
    url,
    mimetype: parsed.mimetype,
  };
};

const prepareThreadsCrossPostSingleMedia = async ({ mediaInputs = [] }) => {
  const normalized = normalizeCrossPostMediaInputs(mediaInputs);
  if (!normalized.length) {
    return {
      mediaUrls: [],
      contentType: 'text',
      mediaStatus: 'none',
      mediaCount: 0,
    };
  }

  const first = normalized[0];
  try {
    let urlToUse = first;
    // If not already a Cloudinary URL, upload it
    if (isHttpUrl(first) && !isCloudinaryUrl(first)) {
      const uploaded = await uploadUrlToCloudinary(first, 'threads');
      urlToUse = uploaded.secure_url || uploaded.url;
    }
    if (isHttpUrl(urlToUse)) {
      const lower = urlToUse.toLowerCase();
      const isVideo = /\.(mp4|mov|m4v|webm|avi|mpeg|mpg)(\?|$)/i.test(lower);
      return {
        mediaUrls: [urlToUse],
        contentType: isVideo ? 'video' : 'image',
        mediaStatus: normalized.length > 1 ? 'posted_partial' : 'posted',
        mediaCount: 1,
      };
    }

    if (first.startsWith('/uploads/')) {
      // Validate uploaded filename matches expected pattern: timestamp-uuid.ext
      const filename = path.basename(first || '');
      const allowedExt = '(jpg|jpeg|png|gif|webp|mp4|mov|m4v|webm|avi|mpeg|mpg)';
      const uploadFilenameRe = new RegExp(`^\d{10,13}-[0-9a-fA-F-]{36}\.${allowedExt}$`, 'i');
      if (!uploadFilenameRe.test(filename)) {
        logger.warn('[internal/threads/cross-post] Ignoring suspicious uploads path', { first, filename });
        return { mediaUrls: [], contentType: 'text', mediaStatus: 'text_only_unsupported', mediaCount: 0 };
      }

      const lower = first.toLowerCase();
      const isVideo = /\.(mp4|mov|m4v|webm|avi|mpeg|mpg)(\?|$)/i.test(lower);
      return {
        mediaUrls: [first],
        contentType: isVideo ? 'video' : 'image',
        mediaStatus: normalized.length > 1 ? 'posted_partial' : 'posted',
        mediaCount: 1,
      };
    }

    if (first.startsWith('data:')) {
      const persisted = await persistDataUrlMediaForThreads(first);
      if (!persisted) {
        return { mediaUrls: [], contentType: 'text', mediaStatus: 'text_only_unsupported', mediaCount: 0 };
      }
      const isVideo = String(persisted.mimetype || '').startsWith('video/');
      return {
        mediaUrls: [persisted.url],
        contentType: isVideo ? 'video' : 'image',
        mediaStatus: normalized.length > 1 ? 'posted_partial' : 'posted',
        mediaCount: 1,
      };
    }
  } catch (error) {
    logger.warn('[internal/threads/cross-post] Failed to prepare media, falling back to text-only', {
      error: error?.message || String(error),
    });
    return { mediaUrls: [], contentType: 'text', mediaStatus: 'text_only_upload_failed', mediaCount: 0 };
  }

  return { mediaUrls: [], contentType: 'text', mediaStatus: 'text_only_unsupported', mediaCount: 0 };
};

const normalizeThreadParts = (parts = []) =>
  (Array.isArray(parts) ? parts : [])
    .map((part) => trimText(part, 600))
    .filter(Boolean)
    .slice(0, 30);

const THREADS_TEXT_MAX_CHARS = Math.max(120, Number.parseInt(process.env.THREADS_TEXT_MAX_CHARS || '500', 10));
const THREADS_AUTO_SPLIT_MAX_CHARS = Math.max(
  THREADS_TEXT_MAX_CHARS,
  Number.parseInt(process.env.THREADS_AUTO_SPLIT_MAX_CHARS || '10000', 10)
);
const THREADS_MAX_CHAIN_POSTS = Math.max(2, Number.parseInt(process.env.THREADS_MAX_CHAIN_POSTS || '30', 10));

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

const buildThreadsCrossPostCaption = ({ mode, content, threadParts }) => {
  if (mode === 'thread' && Array.isArray(threadParts) && threadParts.length > 0) {
    return trimText(threadParts.join('\n\n'), 10000);
  }
  return trimText(content, 10000);
};

const saveThreadsCrossPostHistory = async ({
  platformUserId,
  mode,
  content,
  threadParts = [],
  publishResult,
  mediaDetected = false,
  mediaUrls = [],
  threadsContentType = 'text',
}) => {
  const id = uuidv4();
  const caption = buildThreadsCrossPostCaption({
    mode,
    content,
    threadParts,
  });
  const threadsPostId = String(publishResult?.publishId || publishResult?.creationId || '').trim() || null;
  const threadIds = Array.isArray(publishResult?.threadPostIds)
    ? publishResult.threadPostIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  await query(
    `INSERT INTO social_posts (
       id,
       user_id,
       team_id,
       caption,
       media_urls,
       platforms,
       cross_post,
       threads_content_type,
       status,
       posted_at,
       threads_post_id,
       threads_sequence,
       created_at,
       updated_at
     ) VALUES (
       $1, $2, NULL, $3, $4::jsonb, $5::jsonb, true, $6, 'posted', NOW(), $7, $8::jsonb, NOW(), NOW()
     )`,
    [
      id,
      platformUserId,
      caption || (mode === 'thread' ? '[Threads thread]' : '[Threads post]'),
      JSON.stringify(Array.isArray(mediaUrls) ? mediaUrls : []),
      JSON.stringify(['threads']),
      mode === 'thread' ? 'thread' : threadsContentType,
      threadsPostId,
      JSON.stringify(threadIds),
    ]
  );

  return {
    historyId: id,
    threadsPostId,
    threadPostCount: threadIds.length,
    mediaDetected: Boolean(mediaDetected),
  };
};

const mapThreadsServiceError = (error) => {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || 0);
  const message = String(error?.message || 'Threads publish failed');

  if (code.includes('THREADS_ACCOUNT_INCOMPLETE') || code.includes('THREADS_TOKEN_MISSING')) {
    return { status: 404, code: 'THREADS_NOT_CONNECTED', error: message };
  }
  if (code.includes('THREADS_ACCOUNT_RESOURCE_NOT_FOUND')) {
    return { status: 404, code: 'THREADS_NOT_CONNECTED', error: message };
  }
  if (code.includes('THREADS_CHAIN_MIN_POSTS') || code.includes('THREADS_POST_TOO_LONG') || code.includes('THREADS_TEXT_TOO_LONG')) {
    return { status: 400, code: code || 'THREADS_VALIDATION_ERROR', error: message };
  }
  if (status === 401 || status === 403) {
    return { status: 401, code: 'THREADS_TOKEN_EXPIRED', error: message };
  }
  if (status >= 400 && status < 500) {
    return { status, code: code || 'THREADS_PUBLISH_FAILED', error: message };
  }
  return { status: 500, code: code || 'THREADS_PUBLISH_FAILED', error: message };
};

router.get('/status', ensureInternalRequest, async (req, res) => {
  const platformUserId = resolvePlatformUserId(req);

  if (!platformUserId) {
    return res.status(400).json({
      connected: false,
      reason: 'missing_platform_user_id',
      code: 'PLATFORM_USER_ID_REQUIRED',
    });
  }

  try {
    const account = await getPersonalThreadsAccount(platformUserId);

    if (!account) {
      return res.json({
        connected: false,
        reason: 'not_connected',
        code: 'THREADS_NOT_CONNECTED',
      });
    }

    if (!String(account.access_token || '').trim() || !String(account.account_id || '').trim()) {
      return res.json({
        connected: false,
        reason: 'token_missing',
        code: 'THREADS_TOKEN_MISSING',
      });
    }

    if (isTokenExpired(account.token_expires_at)) {
      return res.json({
        connected: false,
        reason: 'token_expired',
        code: 'THREADS_TOKEN_EXPIRED',
      });
    }

    return res.json({
      connected: true,
      account: {
        id: account.id,
        account_id: account.account_id,
        account_username: account.account_username || null,
      },
    });
  } catch (error) {
    logger.error('[internal/threads/status] Failed to resolve status', {
      userId: platformUserId,
      error: error?.message || String(error),
    });

    return res.status(500).json({
      connected: false,
      reason: 'internal_error',
      code: 'THREADS_STATUS_FAILED',
    });
  }
});

router.get('/targets', ensureInternalRequest, async (req, res) => {
  const platformUserId = resolvePlatformUserId(req);
  const platformTeamId = resolvePlatformTeamId(req);
  const excludeAccountId = String(req.query?.excludeAccountId || '').trim() || null;

  if (!platformUserId) {
    return res.status(400).json({
      error: 'x-platform-user-id is required',
      code: 'PLATFORM_USER_ID_REQUIRED',
    });
  }

  try {
    let rows = [];
    if (platformTeamId) {
      const result = await query(
        `SELECT sca.id, sca.account_id, sca.account_username, sca.account_display_name, sca.profile_image_url
         FROM social_connected_accounts sca
         INNER JOIN team_members tm
           ON tm.team_id::text = sca.team_id::text
          AND tm.user_id = $1
          AND tm.status = 'active'
         WHERE sca.team_id::text = $2::text
           AND sca.platform = 'threads'
           AND sca.is_active = true
         ORDER BY sca.updated_at DESC NULLS LAST, sca.id DESC`,
        [platformUserId, String(platformTeamId)]
      );
      rows = result.rows;
    } else {
      const result = await query(
        `SELECT id, account_id, account_username, account_display_name, profile_image_url
         FROM social_connected_accounts
         WHERE user_id = $1
           AND team_id IS NULL
           AND platform = 'threads'
           AND is_active = true
         ORDER BY updated_at DESC NULLS LAST, id DESC`,
        [platformUserId]
      );
      rows = result.rows;
    }

    const accounts = rows
      .map((row) => ({
        id: row?.id !== undefined && row?.id !== null ? String(row.id) : null,
        platform: 'threads',
        accountId: row?.account_id ? String(row.account_id) : null,
        username: row?.account_username ? String(row.account_username) : null,
        displayName:
          String(row?.account_display_name || '').trim() ||
          (row?.account_username ? `@${String(row.account_username)}` : 'Threads account'),
        avatar: row?.profile_image_url || null,
      }))
      .filter((row) => row.id && row.id !== String(excludeAccountId || ''));

    return res.json({ success: true, accounts });
  } catch (error) {
    logger.error('[internal/threads/targets] Failed to list Threads targets', {
      userId: platformUserId,
      teamId: platformTeamId,
      error: error?.message || String(error),
    });
    return res.status(500).json({
      error: 'Failed to fetch Threads targets',
      code: 'THREADS_TARGETS_FAILED',
    });
  }
});

router.post('/cross-post', ensureInternalRequest, async (req, res) => {
  const platformUserId = resolvePlatformUserId(req);
  const platformTeamId = resolvePlatformTeamId(req);
  const {
    postMode = 'single',
    content = '',
    threadParts = [],
    mediaDetected = false,
    media = [],
    mediaUrls = [],
    targetAccountId = null,
  } = req.body || {};

  if (!platformUserId) {
    return res.status(400).json({
      error: 'x-platform-user-id is required',
      code: 'PLATFORM_USER_ID_REQUIRED',
    });
  }

  const normalizedMode = String(postMode || 'single').toLowerCase() === 'thread' ? 'thread' : 'single';
  const normalizedContent = trimText(content, 5000);
  const normalizedThreadParts = normalizeThreadParts(threadParts);
  const incomingMedia = normalizeCrossPostMediaInputs(
    Array.isArray(media) && media.length > 0 ? media : mediaUrls
  );
  const effectiveMediaDetected = Boolean(mediaDetected) || incomingMedia.length > 0;

  if (normalizedMode === 'thread' && normalizedThreadParts.length < 2) {
    return res.status(400).json({
      error: 'threadParts must contain at least 2 posts for thread mode',
      code: 'THREADS_CHAIN_MIN_POSTS',
    });
  }

  if (normalizedMode === 'single' && !normalizedContent) {
    return res.status(400).json({
      error: 'content is required for single mode',
      code: 'THREADS_CONTENT_REQUIRED',
    });
  }

  try {
    let account = null;
    if (targetAccountId) {
      if (platformTeamId) {
        account = await getTeamThreadsAccountForMemberById(platformUserId, platformTeamId, targetAccountId);
      } else {
        account = await getPersonalThreadsAccountById(platformUserId, targetAccountId);
      }

      if (!account) {
        return res.status(404).json({
          error: 'Target Threads account not found or inaccessible',
          code: 'THREADS_TARGET_ACCOUNT_NOT_FOUND',
        });
      }
    } else if (platformTeamId) {
      account = await getTeamThreadsAccountForMember(platformUserId, platformTeamId);
    } else {
      account = await getPersonalThreadsAccount(platformUserId);
    }

    if (!account) {
      return res.status(404).json({
        error: 'Threads account not connected',
        code: 'THREADS_NOT_CONNECTED',
      });
    }

    if (!String(account.access_token || '').trim() || !String(account.account_id || '').trim()) {
      return res.status(404).json({
        error: 'Threads account is missing token/account details',
        code: 'THREADS_TOKEN_MISSING',
      });
    }

    if (isTokenExpired(account.token_expires_at)) {
      return res.status(401).json({
        error: 'Threads token expired. Reconnect Threads.',
        code: 'THREADS_TOKEN_EXPIRED',
      });
    }

    let publishResult;
    let mediaStatus = effectiveMediaDetected ? 'text_only_unsupported' : 'none';
    let mediaCount = 0;
    let usedMediaUrls = [];
    let usedThreadsContentType = 'text';
    let finalMode = normalizedMode;
    if (normalizedMode === 'thread') {
      if (incomingMedia.length > 0) {
        mediaStatus = 'text_only_thread_mode';
      }
      publishResult = await publishThreadsThread({
        accountId: account.account_id,
        accessToken: account.access_token,
        posts: normalizedThreadParts,
      });
    } else {
      const preparedMedia = await prepareThreadsCrossPostSingleMedia({ mediaInputs: incomingMedia });
      usedMediaUrls = preparedMedia.mediaUrls;
      usedThreadsContentType = preparedMedia.contentType;
      mediaStatus = preparedMedia.mediaStatus;
      mediaCount = preparedMedia.mediaCount;
      // If single post exceeds per-post limit, attempt server-side auto-split into a thread
      if (String(normalizedContent || '').length > THREADS_TEXT_MAX_CHARS) {
        // Auto-split not possible with media attached
        if (incomingMedia.length > 0) {
          return res.status(400).json({ error: 'Single Threads post with media exceeds per-post limit and cannot be auto-split', code: 'THREADS_MEDIA_UNSUPPORTED_AUTO_SPLIT' });
        }

        if (String(normalizedContent || '').length <= THREADS_AUTO_SPLIT_MAX_CHARS) {
          const parts = splitTextByLimit(normalizedContent, THREADS_TEXT_MAX_CHARS).slice(0, THREADS_MAX_CHAIN_POSTS);
          if (parts.length >= 2) {
            finalMode = 'thread';
            publishResult = await publishThreadsThread({
              accountId: account.account_id,
              accessToken: account.access_token,
              posts: parts,
            });
            // mark media values accordingly (no media)
            usedMediaUrls = [];
            usedThreadsContentType = 'text';
            mediaStatus = 'none';
            mediaCount = 0;
          } else {
            // Fallback to attempt single post (will likely fail with text too long)
            publishResult = await publishThreadsPost({
              accountId: account.account_id,
              accessToken: account.access_token,
              text: normalizedContent,
              mediaUrls: preparedMedia.mediaUrls,
              contentType: preparedMedia.contentType,
              requestHost: req.get('host') || null,
            });
          }
        } else {
          return res.status(400).json({ error: `Threads text must be ${THREADS_AUTO_SPLIT_MAX_CHARS} characters or fewer`, code: 'THREADS_TEXT_TOO_LONG' });
        }
      } else {
        publishResult = await publishThreadsPost({
          accountId: account.account_id,
          accessToken: account.access_token,
          text: normalizedContent,
          mediaUrls: preparedMedia.mediaUrls,
          contentType: preparedMedia.contentType,
          requestHost: req.get('host') || null,
        });
      }
    }

    logger.info('[internal/threads/cross-post] Posted to Threads', {
      userId: platformUserId,
      mode: finalMode,
      mediaDetected: Boolean(effectiveMediaDetected),
      mediaStatus,
      mediaCount,
      publishId: publishResult?.publishId || null,
      threadPostCount: Array.isArray(publishResult?.threadPostIds) ? publishResult.threadPostIds.length : 0,
    });

    try {
      const historySave = await saveThreadsCrossPostHistory({
        platformUserId,
        mode: finalMode,
        content: normalizedContent,
        threadParts: normalizedThreadParts,
        publishResult,
        mediaDetected: effectiveMediaDetected,
        mediaUrls: usedMediaUrls,
        threadsContentType: usedThreadsContentType,
      });
      logger.info('[internal/threads/cross-post] Saved Social history row for Threads cross-post', {
        userId: platformUserId,
        historyId: historySave.historyId,
        mode: normalizedMode,
      });
    } catch (historyError) {
      logger.warn('[internal/threads/cross-post] Posted to Threads but failed to save social_posts history row', {
        userId: platformUserId,
        mode: normalizedMode,
        error: historyError?.message || String(historyError),
      });
    }

    return res.json({
      success: true,
      status: 'posted',
      mode: normalizedMode,
      mediaDetected: Boolean(effectiveMediaDetected),
      mediaStatus,
      mediaCount,
      publishId: publishResult?.publishId || null,
      threadPostIds: Array.isArray(publishResult?.threadPostIds) ? publishResult.threadPostIds : [],
    });
  } catch (error) {
    const mapped = mapThreadsServiceError(error);
    logger.error('[internal/threads/cross-post] Failed to post to Threads', {
      userId: platformUserId,
      mode: normalizedMode,
      error: error?.message || String(error),
      code: mapped.code,
      status: mapped.status,
    });

    return res.status(mapped.status).json({
      error: mapped.error,
      code: mapped.code,
    });
  }
});

export default router;
