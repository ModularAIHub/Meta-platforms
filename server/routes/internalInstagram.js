import express from 'express';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { publishInstagramPost } from '../services/instagramService.js';
import { uploadUrlToCloudinary, uploadBufferToCloudinary, isCloudinaryUrl } from '../utils/cloudinaryUpload.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

const INTERNAL_CROSSPOST_MAX_MEDIA_ITEMS = 10;
const INTERNAL_CROSSPOST_MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const INSTAGRAM_CAPTION_MAX_CHARS = Math.max(
  2200,
  Number.parseInt(process.env.INSTAGRAM_CAPTION_MAX_CHARS || '2200', 10)
);
const UPLOAD_FILENAME_RE = /^\d{10,13}-[0-9a-fA-F-]{36}\.(jpg|jpeg|png|gif|webp|mp4|mov|m4v|webm|avi|mpeg|mpg)$/i;

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

const isTokenExpired = (tokenExpiresAt) => {
  if (!tokenExpiresAt) return false;
  const expiresMs = new Date(tokenExpiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs <= Date.now();
};

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

  return { mimetype, buffer };
};

const persistDataUrlMediaForInstagram = async (value) => {
  const parsed = parseDataUrl(value);
  if (!parsed) return null;

  const uploaded = await uploadBufferToCloudinary(parsed.buffer, parsed.mimetype, 'instagram');
  const url = uploaded.secure_url || uploaded.url;
  if (!url) throw new Error('Cloudinary upload returned no URL');

  return {
    url,
    mimetype: parsed.mimetype,
  };
};

const getPersonalInstagramAccount = async (platformUserId) => {
  if (!platformUserId) return null;

  const result = await query(
    `SELECT id, user_id, team_id, account_id, account_username, account_display_name, profile_image_url,
            access_token, token_expires_at, metadata
     FROM social_connected_accounts
     WHERE user_id = $1
       AND team_id IS NULL
       AND platform = 'instagram'
       AND is_active = true
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [platformUserId]
  );

  return result.rows[0] || null;
};

const getPersonalInstagramAccountById = async (platformUserId, targetAccountId) => {
  if (!platformUserId || !targetAccountId) return null;

  const result = await query(
    `SELECT id, user_id, team_id, account_id, account_username, account_display_name, profile_image_url,
            access_token, token_expires_at, metadata
     FROM social_connected_accounts
     WHERE user_id = $1
       AND team_id IS NULL
       AND platform = 'instagram'
       AND is_active = true
       AND id::text = $2::text
     LIMIT 1`,
    [platformUserId, String(targetAccountId)]
  );

  return result.rows[0] || null;
};

const getTeamInstagramAccountForMember = async (platformUserId, platformTeamId) => {
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
       AND sca.platform = 'instagram'
       AND sca.is_active = true
     ORDER BY sca.updated_at DESC NULLS LAST, sca.id DESC
     LIMIT 1`,
    [platformUserId, String(platformTeamId)]
  );

  return result.rows[0] || null;
};

const getTeamInstagramAccountForMemberById = async (platformUserId, platformTeamId, targetAccountId) => {
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
       AND sca.platform = 'instagram'
       AND sca.is_active = true
       AND sca.id::text = $3::text
     LIMIT 1`,
    [platformUserId, String(platformTeamId), String(targetAccountId)]
  );

  return result.rows[0] || null;
};

const normalizeThreadParts = (parts = []) =>
  (Array.isArray(parts) ? parts : [])
    .map((part) => trimText(part, 1200))
    .filter(Boolean)
    .slice(0, 30);

const buildInstagramCrossPostCaption = ({ mode, content, threadParts }) => {
  if (mode === 'thread' && Array.isArray(threadParts) && threadParts.length > 0) {
    return trimText(threadParts.join('\n\n'), INSTAGRAM_CAPTION_MAX_CHARS);
  }
  return trimText(content, INSTAGRAM_CAPTION_MAX_CHARS);
};

const normalizeInstagramContentType = (requestedType, mediaUrls = []) => {
  const normalizedRequested = String(requestedType || '').trim().toLowerCase();
  if (normalizedRequested === 'carousel' && mediaUrls.length >= 2) return 'carousel';
  if (normalizedRequested === 'story') return 'story';
  if (normalizedRequested === 'reel') return 'reel';
  if (mediaUrls.length >= 2) return 'carousel';
  return 'feed';
};

const resolveInstagramMediaInput = async (value) => {
  if (isHttpUrl(value)) {
    if (isCloudinaryUrl(value)) {
      return value;
    }
    const uploaded = await uploadUrlToCloudinary(value, 'instagram');
    return uploaded.secure_url || uploaded.url || null;
  }

  if (value.startsWith('/uploads/')) {
    const filename = path.basename(value || '');
    if (!UPLOAD_FILENAME_RE.test(filename)) {
      logger.warn('[internal/instagram/cross-post] Ignoring suspicious uploads path', { value, filename });
      return null;
    }
    return value;
  }

  if (value.startsWith('data:')) {
    const persisted = await persistDataUrlMediaForInstagram(value);
    return persisted?.url || null;
  }

  return null;
};

const prepareInstagramCrossPostMedia = async ({ mediaInputs = [], requestedType = 'feed' }) => {
  const normalized = normalizeCrossPostMediaInputs(mediaInputs);
  if (!normalized.length) {
    return {
      mediaUrls: [],
      contentType: normalizeInstagramContentType(requestedType, []),
      mediaStatus: 'none',
      mediaCount: 0,
    };
  }

  try {
    const resolved = [];
    for (const item of normalized) {
      const next = await resolveInstagramMediaInput(item);
      if (next) resolved.push(next);
    }

    const mediaUrls = resolved.slice(0, INTERNAL_CROSSPOST_MAX_MEDIA_ITEMS);
    return {
      mediaUrls,
      contentType: normalizeInstagramContentType(requestedType, mediaUrls),
      mediaStatus: mediaUrls.length === normalized.length ? 'posted' : 'posted_partial',
      mediaCount: mediaUrls.length,
    };
  } catch (error) {
    logger.warn('[internal/instagram/cross-post] Failed to prepare media', {
      error: error?.message || String(error),
    });
    return {
      mediaUrls: [],
      contentType: normalizeInstagramContentType(requestedType, []),
      mediaStatus: 'upload_failed',
      mediaCount: 0,
    };
  }
};

const saveInstagramCrossPostHistory = async ({
  platformUserId,
  platformTeamId = null,
  mode,
  content,
  threadParts = [],
  publishResult,
  mediaDetected = false,
  mediaUrls = [],
  instagramContentType = 'feed',
}) => {
  const id = uuidv4();
  const caption = buildInstagramCrossPostCaption({
    mode,
    content,
    threadParts,
  });
  const instagramPostId = String(publishResult?.publishId || publishResult?.creationId || '').trim() || null;

  await query(
    `INSERT INTO social_posts (
       id,
       user_id,
       team_id,
       caption,
       media_urls,
       platforms,
       cross_post,
       instagram_content_type,
       status,
       posted_at,
       instagram_post_id,
       created_at,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, $6::jsonb, true, $7, 'posted', NOW(), $8, NOW(), NOW()
     )`,
    [
      id,
      platformUserId,
      platformTeamId,
      caption || '[Instagram post]',
      JSON.stringify(Array.isArray(mediaUrls) ? mediaUrls : []),
      JSON.stringify(['instagram']),
      instagramContentType,
      instagramPostId,
    ]
  );

  return {
    historyId: id,
    instagramPostId,
    mediaDetected: Boolean(mediaDetected),
    mediaCount: Array.isArray(mediaUrls) ? mediaUrls.length : 0,
  };
};

const mapInstagramServiceError = (error) => {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || 0);
  const message = String(error?.message || 'Instagram publish failed');

  if (code.includes('INSTAGRAM_ACCOUNT_INCOMPLETE') || code.includes('INSTAGRAM_TOKEN_MISSING')) {
    return { status: 404, code: 'INSTAGRAM_NOT_CONNECTED', error: message };
  }
  if (code.includes('INSTAGRAM_ACCOUNT_RESOURCE_NOT_FOUND')) {
    return { status: 404, code: 'INSTAGRAM_NOT_CONNECTED', error: message };
  }
  if (
    code.includes('INSTAGRAM_MEDIA_REQUIRED') ||
    code.includes('INSTAGRAM_REEL_VIDEO_REQUIRED') ||
    code.includes('INSTAGRAM_MEDIA_PROCESSING_FAILED') ||
    code.includes('INSTAGRAM_MEDIA_PROCESSING_TIMEOUT')
  ) {
    return { status: 400, code: code || 'INSTAGRAM_VALIDATION_ERROR', error: message };
  }
  if (status === 401 || status === 403) {
    return { status: 401, code: 'INSTAGRAM_TOKEN_EXPIRED', error: message };
  }
  if (status >= 400 && status < 500) {
    return { status, code: code || 'INSTAGRAM_PUBLISH_FAILED', error: message };
  }
  return { status: 500, code: code || 'INSTAGRAM_PUBLISH_FAILED', error: message };
};

const resolveInstagramAccountSelection = async ({ platformUserId, platformTeamId, targetAccountId = null }) => {
  if (targetAccountId) {
    if (platformTeamId) {
      return getTeamInstagramAccountForMemberById(platformUserId, platformTeamId, targetAccountId);
    }
    return getPersonalInstagramAccountById(platformUserId, targetAccountId);
  }

  if (platformTeamId) {
    return getTeamInstagramAccountForMember(platformUserId, platformTeamId);
  }

  return getPersonalInstagramAccount(platformUserId);
};

router.get('/status', ensureInternalRequest, async (req, res) => {
  const platformUserId = resolvePlatformUserId(req);
  const platformTeamId = resolvePlatformTeamId(req);

  if (!platformUserId) {
    return res.status(400).json({
      connected: false,
      reason: 'missing_platform_user_id',
      code: 'PLATFORM_USER_ID_REQUIRED',
    });
  }

  try {
    const account = await resolveInstagramAccountSelection({
      platformUserId,
      platformTeamId,
    });

    if (!account) {
      return res.json({
        connected: false,
        reason: 'not_connected',
        code: 'INSTAGRAM_NOT_CONNECTED',
      });
    }

    if (!String(account.access_token || '').trim() || !String(account.account_id || '').trim()) {
      return res.json({
        connected: false,
        reason: 'token_missing',
        code: 'INSTAGRAM_TOKEN_MISSING',
      });
    }

    if (isTokenExpired(account.token_expires_at)) {
      return res.json({
        connected: false,
        reason: 'token_expired',
        code: 'INSTAGRAM_TOKEN_EXPIRED',
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
    logger.error('[internal/instagram/status] Failed to resolve status', {
      userId: platformUserId,
      teamId: platformTeamId,
      error: error?.message || String(error),
    });

    return res.status(500).json({
      connected: false,
      reason: 'internal_error',
      code: 'INSTAGRAM_STATUS_FAILED',
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
           AND sca.platform = 'instagram'
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
           AND platform = 'instagram'
           AND is_active = true
         ORDER BY updated_at DESC NULLS LAST, id DESC`,
        [platformUserId]
      );
      rows = result.rows;
    }

    const accounts = rows
      .map((row) => ({
        id: row?.id !== undefined && row?.id !== null ? String(row.id) : null,
        platform: 'instagram',
        accountId: row?.account_id ? String(row.account_id) : null,
        username: row?.account_username ? String(row.account_username) : null,
        displayName:
          String(row?.account_display_name || '').trim() ||
          (row?.account_username ? `@${String(row.account_username)}` : 'Instagram account'),
        avatar: row?.profile_image_url || null,
      }))
      .filter((row) => row.id && row.id !== String(excludeAccountId || ''));

    return res.json({ success: true, accounts });
  } catch (error) {
    logger.error('[internal/instagram/targets] Failed to list Instagram targets', {
      userId: platformUserId,
      teamId: platformTeamId,
      error: error?.message || String(error),
    });
    return res.status(500).json({
      error: 'Failed to fetch Instagram targets',
      code: 'INSTAGRAM_TARGETS_FAILED',
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
    instagramContentType = 'feed',
  } = req.body || {};

  if (!platformUserId) {
    return res.status(400).json({
      error: 'x-platform-user-id is required',
      code: 'PLATFORM_USER_ID_REQUIRED',
    });
  }

  const normalizedMode = String(postMode || 'single').toLowerCase() === 'thread' ? 'thread' : 'single';
  const normalizedContent = trimText(content, INSTAGRAM_CAPTION_MAX_CHARS);
  const normalizedThreadParts = normalizeThreadParts(threadParts);
  const incomingMedia = normalizeCrossPostMediaInputs(
    Array.isArray(media) && media.length > 0 ? media : mediaUrls
  );
  const effectiveMediaDetected = Boolean(mediaDetected) || incomingMedia.length > 0;
  const caption = buildInstagramCrossPostCaption({
    mode: normalizedMode,
    content: normalizedContent,
    threadParts: normalizedThreadParts,
  });

  if (normalizedMode === 'thread' && normalizedThreadParts.length < 2) {
    return res.status(400).json({
      error: 'threadParts must contain at least 2 parts for thread mode',
      code: 'INSTAGRAM_THREAD_MIN_PARTS',
    });
  }

  try {
    const account = await resolveInstagramAccountSelection({
      platformUserId,
      platformTeamId,
      targetAccountId,
    });

    if (!account) {
      return res.status(404).json({
        error: 'Instagram account not connected',
        code: 'INSTAGRAM_NOT_CONNECTED',
      });
    }

    if (!String(account.access_token || '').trim() || !String(account.account_id || '').trim()) {
      return res.status(404).json({
        error: 'Instagram account is missing token/account details',
        code: 'INSTAGRAM_TOKEN_MISSING',
      });
    }

    if (isTokenExpired(account.token_expires_at)) {
      return res.status(401).json({
        error: 'Instagram token expired. Reconnect Instagram.',
        code: 'INSTAGRAM_TOKEN_EXPIRED',
      });
    }

    const preparedMedia = await prepareInstagramCrossPostMedia({
      mediaInputs: incomingMedia,
      requestedType: instagramContentType,
    });

    if (!preparedMedia.mediaUrls.length) {
      return res.status(400).json({
        error: 'Instagram publishing requires at least one valid media file or URL',
        code: 'INSTAGRAM_MEDIA_REQUIRED',
      });
    }

    const publishResult = await publishInstagramPost({
      accountId: account.account_id,
      accessToken: account.access_token,
      mediaUrls: preparedMedia.mediaUrls,
      caption,
      contentType: preparedMedia.contentType,
      requestHost: req.get('host') || null,
    });

    logger.info('[internal/instagram/cross-post] Posted to Instagram', {
      userId: platformUserId,
      teamId: platformTeamId,
      targetAccountId: account.id,
      mediaCount: preparedMedia.mediaCount,
      contentType: preparedMedia.contentType,
    });

    let historySave = null;
    try {
      historySave = await saveInstagramCrossPostHistory({
        platformUserId,
        platformTeamId,
        mode: normalizedMode,
        content: normalizedContent,
        threadParts: normalizedThreadParts,
        publishResult,
        mediaDetected: effectiveMediaDetected,
        mediaUrls: preparedMedia.mediaUrls,
        instagramContentType: preparedMedia.contentType,
      });
    } catch (historyError) {
      logger.warn('[internal/instagram/cross-post] Posted to Instagram but failed to save social_posts history row', {
        userId: platformUserId,
        teamId: platformTeamId,
        error: historyError?.message || String(historyError),
      });
    }

    return res.json({
      success: true,
      publishId: publishResult.publishId || publishResult.creationId || null,
      creationId: publishResult.creationId || null,
      accountId: account.id,
      instagramContentType: preparedMedia.contentType,
      mediaCount: preparedMedia.mediaCount,
      mediaStatus: preparedMedia.mediaStatus,
      history: historySave,
    });
  } catch (error) {
    const mapped = mapInstagramServiceError(error);
    logger.error('[internal/instagram/cross-post] Failed to post to Instagram', {
      userId: platformUserId,
      teamId: platformTeamId,
      error: mapped.error,
      code: mapped.code,
    });

    return res.status(mapped.status).json({
      error: mapped.error,
      code: mapped.code,
    });
  }
});

export default router;
