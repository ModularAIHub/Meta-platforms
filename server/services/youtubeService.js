import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { query } from '../config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsRoot = path.resolve(__dirname, '..', 'uploads');

const YOUTUBE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YOUTUBE_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const YOUTUBE_UPLOAD_TIMEOUT_MS = Math.max(30000, Number.parseInt(process.env.YOUTUBE_UPLOAD_TIMEOUT_MS || '900000', 10));
const YOUTUBE_REFRESH_SKEW_MS = Math.max(30000, Number.parseInt(process.env.YOUTUBE_REFRESH_SKEW_MS || '60000', 10));
const YOUTUBE_DEFAULT_PRIVACY_STATUS = process.env.YOUTUBE_DEFAULT_PRIVACY_STATUS || 'public';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mpeg', '.mpg', '.mkv']);

const MIME_BY_EXTENSION = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mkv': 'video/x-matroska',
};

const asHttpError = (status, message, code = null) => {
  const error = new Error(message);
  error.status = status;
  if (code) {
    error.code = code;
  }
  return error;
};

const inferMimeType = (inputUrl, fallback = 'video/mp4') => {
  try {
    const value = String(inputUrl || '').trim();
    const parsed = value.startsWith('http://') || value.startsWith('https://')
      ? new URL(value)
      : new URL(`https://dummy.local${value.startsWith('/') ? '' : '/'}${value}`);
    const ext = path.extname(parsed.pathname || '').toLowerCase();
    return MIME_BY_EXTENSION[ext] || fallback;
  } catch {
    return fallback;
  }
};

const isVideoUrl = (value) => {
  try {
    const parsed = value.startsWith('http://') || value.startsWith('https://')
      ? new URL(value)
      : new URL(`https://dummy.local${value.startsWith('/') ? '' : '/'}${value}`);
    const ext = path.extname(parsed.pathname || '').toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
};

const selectVideoMediaUrl = (mediaUrls = []) => {
  const normalized = Array.isArray(mediaUrls)
    ? mediaUrls.map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  if (normalized.length === 0) {
    throw asHttpError(400, 'YouTube posting requires at least one uploaded video file', 'YOUTUBE_MEDIA_REQUIRED');
  }

  const matchedVideo = normalized.find((value) => isVideoUrl(value));
  if (!matchedVideo) {
    throw asHttpError(400, 'YouTube posting requires a video file (.mp4/.mov/.webm)', 'YOUTUBE_VIDEO_REQUIRED');
  }

  return matchedVideo;
};

const toLocalUploadPath = (inputUrl) => {
  const clean = String(inputUrl || '').split('?')[0].split('#')[0].trim();
  const normalized = clean.replace(/\\/g, '/');

  if (normalized.startsWith('/uploads/')) {
    return path.resolve(uploadsRoot, normalized.slice('/uploads/'.length));
  }

  if (normalized.startsWith('uploads/')) {
    return path.resolve(uploadsRoot, normalized.slice('uploads/'.length));
  }

  return null;
};

const openLocalMediaStream = async (mediaUrl) => {
  const localPath = toLocalUploadPath(mediaUrl);
  if (!localPath) {
    return null;
  }

  let stats;
  try {
    stats = await fs.promises.stat(localPath);
  } catch {
    throw asHttpError(400, 'Uploaded video file not found on server', 'YOUTUBE_MEDIA_NOT_FOUND');
  }

  if (!stats.isFile()) {
    throw asHttpError(400, 'Invalid uploaded video file path', 'YOUTUBE_MEDIA_INVALID');
  }

  const mimeType = inferMimeType(localPath, 'video/mp4');

  return {
    mimeType,
    size: stats.size,
    createStream: () => fs.createReadStream(localPath),
  };
};

const openRemoteMediaStream = async (mediaUrl) => {
  if (!(mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://'))) {
    throw asHttpError(
      400,
      'YouTube media URL must be absolute or a local /uploads path.',
      'YOUTUBE_MEDIA_URL_INVALID'
    );
  }

  const mimeType = inferMimeType(mediaUrl, 'video/mp4');
  return {
    mimeType,
    size: null,
    createStream: async () => {
      const response = await axios.get(mediaUrl, {
        responseType: 'stream',
        timeout: 120000,
      });

      return {
        stream: response.data,
        size: Number.parseInt(response.headers?.['content-length'] || '0', 10) || null,
        mimeType: response.headers?.['content-type'] || mimeType,
      };
    },
  };
};

const openMediaSource = async (mediaUrl) => {
  const local = await openLocalMediaStream(mediaUrl);
  if (local) {
    return {
      getPayload: async () => ({
        stream: local.createStream(),
        size: local.size,
        mimeType: local.mimeType,
      }),
    };
  }

  const remote = await openRemoteMediaStream(mediaUrl);
  return {
    getPayload: async () => remote.createStream(),
  };
};

const parseTitle = (caption) => {
  const fallback = 'Meta Genie Upload';
  const raw = String(caption || '').trim();
  if (!raw) return fallback;

  const firstLine = raw.split('\n').map((line) => line.trim()).find(Boolean) || raw;
  const compact = firstLine.replace(/\s+/g, ' ').trim();
  if (!compact) return fallback;
  return compact.length > 100 ? `${compact.slice(0, 97).trim()}...` : compact;
};

const parseDescription = (caption, contentType) => {
  const base = String(caption || '').trim();
  let description = base.length > 5000 ? `${base.slice(0, 4997).trim()}...` : base;

  if (String(contentType || '').toLowerCase() === 'short' && !/#shorts/i.test(description)) {
    description = `${description}${description ? '\n\n' : ''}#Shorts`;
  }

  return description;
};

const refreshYoutubeAccessToken = async (refreshToken) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';

  if (!clientId || !clientSecret) {
    throw asHttpError(500, 'Google OAuth client credentials are missing', 'YOUTUBE_OAUTH_NOT_CONFIGURED');
  }

  const response = await axios.post(
    YOUTUBE_OAUTH_TOKEN_ENDPOINT,
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 20000,
    }
  );

  const accessToken = String(response.data?.access_token || '').trim();
  const expiresIn = Number.parseInt(response.data?.expires_in || '0', 10);

  if (!accessToken) {
    throw asHttpError(400, 'Failed to refresh YouTube access token', 'YOUTUBE_TOKEN_REFRESH_FAILED');
  }

  const tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + (expiresIn * 1000)).toISOString()
    : null;

  return { accessToken, tokenExpiresAt };
};

const persistAccessToken = async (connectionId, accessToken, tokenExpiresAt) => {
  await query(
    `UPDATE social_connected_accounts
     SET access_token = $1,
         token_expires_at = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [accessToken, tokenExpiresAt, connectionId]
  );
};

const shouldRefreshToken = (tokenExpiresAt) => {
  if (!tokenExpiresAt) return false;
  const expiresAtMs = new Date(tokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs <= (Date.now() + YOUTUBE_REFRESH_SKEW_MS);
};

const ensureYoutubeAccessToken = async (connection, { forceRefresh = false } = {}) => {
  const currentToken = String(connection?.access_token || '').trim();
  const refreshToken = String(connection?.refresh_token || '').trim();
  const tokenExpiresAt = connection?.token_expires_at || null;
  const connectionId = connection?.id || null;

  if (!forceRefresh && currentToken && !shouldRefreshToken(tokenExpiresAt)) {
    return currentToken;
  }

  if (!refreshToken) {
    if (currentToken && !forceRefresh) {
      return currentToken;
    }
    throw asHttpError(400, 'YouTube token expired. Reconnect YouTube account.', 'YOUTUBE_TOKEN_EXPIRED');
  }

  const refreshed = await refreshYoutubeAccessToken(refreshToken);
  if (connectionId) {
    await persistAccessToken(connectionId, refreshed.accessToken, refreshed.tokenExpiresAt);
  }

  connection.access_token = refreshed.accessToken;
  connection.token_expires_at = refreshed.tokenExpiresAt;
  return refreshed.accessToken;
};

const createResumableSession = async ({ accessToken, mimeType, size, caption, contentType }) => {
  const metadata = {
    snippet: {
      title: parseTitle(caption),
      description: parseDescription(caption, contentType),
      categoryId: '22',
    },
    status: {
      privacyStatus: YOUTUBE_DEFAULT_PRIVACY_STATUS,
    },
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType,
  };

  if (Number.isFinite(size) && size > 0) {
    headers['X-Upload-Content-Length'] = String(size);
  }

  const response = await axios.post(
    `${YOUTUBE_UPLOAD_ENDPOINT}?uploadType=resumable&part=snippet,status`,
    metadata,
    {
      headers,
      timeout: 30000,
      validateStatus: (status) => status >= 200 && status < 400,
    }
  );

  const sessionUrl = response.headers?.location || response.headers?.Location;
  if (!sessionUrl) {
    throw asHttpError(400, 'Failed to initialize YouTube upload session', 'YOUTUBE_UPLOAD_SESSION_FAILED');
  }

  return sessionUrl;
};

const uploadVideoContent = async ({ sessionUrl, accessToken, stream, mimeType, size }) => {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': mimeType,
  };

  if (Number.isFinite(size) && size > 0) {
    headers['Content-Length'] = String(size);
  }

  const response = await axios.put(sessionUrl, stream, {
    headers,
    timeout: YOUTUBE_UPLOAD_TIMEOUT_MS,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const videoId = String(response.data?.id || '').trim();
  if (!videoId) {
    throw asHttpError(400, 'YouTube upload completed without a video ID', 'YOUTUBE_UPLOAD_NO_VIDEO_ID');
  }

  return videoId;
};

const runUpload = async ({ accessToken, mediaFactory, caption, contentType }) => {
  const payload = await mediaFactory.getPayload();
  const sessionUrl = await createResumableSession({
    accessToken,
    mimeType: payload.mimeType,
    size: payload.size,
    caption,
    contentType,
  });

  return uploadVideoContent({
    sessionUrl,
    accessToken,
    stream: payload.stream,
    mimeType: payload.mimeType,
    size: payload.size,
  });
};

export const publishYoutubeVideo = async ({
  connection,
  mediaUrls = [],
  caption = '',
  contentType = 'video',
}) => {
  if (!connection?.id || !connection?.account_id) {
    throw asHttpError(400, 'YouTube account is not fully connected', 'YOUTUBE_ACCOUNT_INCOMPLETE');
  }

  const selectedVideoUrl = selectVideoMediaUrl(mediaUrls);
  const mediaFactory = await openMediaSource(selectedVideoUrl);

  let accessToken = await ensureYoutubeAccessToken(connection);

  try {
    const videoId = await runUpload({
      accessToken,
      mediaFactory,
      caption,
      contentType,
    });
    return { videoId };
  } catch (error) {
    const status = error?.response?.status;
    if (status === 401 && connection.refresh_token) {
      accessToken = await ensureYoutubeAccessToken(connection, { forceRefresh: true });
      const videoId = await runUpload({
        accessToken,
        mediaFactory,
        caption,
        contentType,
      });
      return { videoId };
    }

    throw error;
  }
};

