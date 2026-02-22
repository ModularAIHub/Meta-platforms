import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { publishThreadsPost, publishThreadsThread } from '../services/threadsService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

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

const isTokenExpired = (tokenExpiresAt) => {
  if (!tokenExpiresAt) return false;
  const expiresMs = new Date(tokenExpiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs <= Date.now();
};

const trimText = (value, maxLength = 5000) => String(value || '').trim().slice(0, maxLength);

const normalizeThreadParts = (parts = []) =>
  (Array.isArray(parts) ? parts : [])
    .map((part) => trimText(part, 600))
    .filter(Boolean)
    .slice(0, 30);

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
      JSON.stringify([]), // Phase 1 cross-posts are text-only fallback
      JSON.stringify(['threads']),
      mode === 'thread' ? 'thread' : 'text',
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

router.post('/cross-post', ensureInternalRequest, async (req, res) => {
  const platformUserId = resolvePlatformUserId(req);
  const {
    postMode = 'single',
    content = '',
    threadParts = [],
    mediaDetected = false,
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
    const account = await getPersonalThreadsAccount(platformUserId);

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
    if (normalizedMode === 'thread') {
      publishResult = await publishThreadsThread({
        accountId: account.account_id,
        accessToken: account.access_token,
        posts: normalizedThreadParts,
      });
    } else {
      publishResult = await publishThreadsPost({
        accountId: account.account_id,
        accessToken: account.access_token,
        text: normalizedContent,
        mediaUrls: [],
        contentType: 'text',
      });
    }

    logger.info('[internal/threads/cross-post] Posted to Threads', {
      userId: platformUserId,
      mode: normalizedMode,
      mediaDetected: Boolean(mediaDetected),
      publishId: publishResult?.publishId || null,
      threadPostCount: Array.isArray(publishResult?.threadPostIds) ? publishResult.threadPostIds.length : 0,
    });

    try {
      const historySave = await saveThreadsCrossPostHistory({
        platformUserId,
        mode: normalizedMode,
        content: normalizedContent,
        threadParts: normalizedThreadParts,
        publishResult,
        mediaDetected,
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
      mediaDetected: Boolean(mediaDetected),
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
