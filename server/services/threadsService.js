import axios from 'axios';

const THREADS_GRAPH_BASE = 'https://graph.threads.net';
const THREADS_API_VERSION = process.env.THREADS_API_VERSION || 'v1.0';
const THREADS_TEXT_MAX_CHARS = Math.max(120, Number.parseInt(process.env.THREADS_TEXT_MAX_CHARS || '500', 10));
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mpeg', '.mpg']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const asHttpError = (status, message, code = null) => {
  const error = new Error(message);
  error.status = status;
  if (code) {
    error.code = code;
  }
  return error;
};

const extractProviderError = (error) =>
  error?.response?.data?.error?.message ||
  error?.response?.data?.message ||
  error?.message ||
  '';

const isMissingResourceError = (error) => {
  const message = extractProviderError(error).toLowerCase();
  return message.includes('requested resource does not exist') ||
    message.includes('unsupported get request') ||
    message.includes('does not exist');
};

const getPublicBaseUrl = () => String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || '').trim();

const joinUrl = (base, path) => {
  const cleanBase = String(base || '').replace(/\/$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
};

const resolvePublicMediaUrl = (inputUrl, requestHost = null) => {
  const value = String(inputUrl || '').trim();
  if (!value) {
    throw asHttpError(400, 'Media URL is required for Threads publishing', 'THREADS_MEDIA_URL_REQUIRED');
  }

  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }

  const publicBaseUrl = getPublicBaseUrl();
  if (publicBaseUrl) {
    return joinUrl(publicBaseUrl, value);
  }

  if (requestHost && !/localhost|127\.0\.0\.1/i.test(requestHost)) {
    return joinUrl(`https://${requestHost}`, value);
  }

  throw asHttpError(
    400,
    'Relative media URLs require PUBLIC_BASE_URL (set it to your ngrok or production API domain)',
    'PUBLIC_BASE_URL_REQUIRED'
  );
};

const isVideoUrl = (url) => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    for (const extension of VIDEO_EXTENSIONS) {
      if (path.endsWith(extension)) {
        return true;
      }
    }
  } catch {
    // no-op
  }

  return false;
};

const createThreadsContainer = async ({
  accountId,
  accessToken,
  mediaType,
  text,
  imageUrl,
  videoUrl,
  replyToId,
}) => {
  const endpoint = `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${accountId}/threads`;

  const payload = new URLSearchParams();
  payload.append('media_type', mediaType);
  payload.append('access_token', accessToken);

  if (text) {
    payload.append('text', text);
  }
  if (imageUrl) {
    payload.append('image_url', imageUrl);
  }
  if (videoUrl) {
    payload.append('video_url', videoUrl);
  }
  if (replyToId) {
    payload.append('reply_to_id', replyToId);
  }

  const response = await axios.post(endpoint, payload.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 25000,
  });

  return response.data;
};

const publishThreadsContainer = async ({ accountId, accessToken, creationId }) => {
  const endpoint = `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${accountId}/threads_publish`;

  const payload = new URLSearchParams();
  payload.append('creation_id', creationId);
  payload.append('access_token', accessToken);

  const response = await axios.post(endpoint, payload.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 25000,
  });

  return response.data;
};

const waitForVideoContainer = async (containerId, accessToken) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await axios.get(`${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${containerId}`, {
      params: {
        fields: 'status',
        access_token: accessToken,
      },
      timeout: 15000,
    });

    const status = String(response.data?.status || '').toUpperCase();

    if (status === 'FINISHED' || status === 'PUBLISHED' || status === 'READY') {
      return;
    }

    if (status === 'ERROR' || status === 'EXPIRED') {
      throw asHttpError(400, `Threads video processing failed (${status})`, 'THREADS_VIDEO_PROCESSING_FAILED');
    }

    await sleep(3000);
  }

  throw asHttpError(408, 'Threads video processing timed out', 'THREADS_VIDEO_PROCESSING_TIMEOUT');
};

const publishThreadsContainerWithRetry = async ({ accountId, accessToken, creationId }) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await publishThreadsContainer({ accountId, accessToken, creationId });
    } catch (error) {
      if (isMissingResourceError(error) && attempt === 0) {
        await sleep(1200);
        continue;
      }
      if (isMissingResourceError(error)) {
        throw asHttpError(
          400,
          'Threads publish resource not found. Reconnect Threads and try again.',
          'THREADS_PUBLISH_RESOURCE_NOT_FOUND'
        );
      }
      throw error;
    }
  }

  throw asHttpError(400, 'Threads publish failed', 'THREADS_PUBLISH_FAILED');
};

const resolveLiveThreadsAccountId = async ({ accountId, accessToken }) => {
  try {
    const response = await axios.get(`${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/me`, {
      params: {
        fields: 'id',
        access_token: accessToken,
      },
      timeout: 15000,
    });

    const liveId = String(response.data?.id || '').trim();
    if (liveId) {
      return liveId;
    }
  } catch {
    // Fall back to stored account id when live lookup is temporarily unavailable.
  }

  return String(accountId || '').trim();
};

export const publishThreadsPost = async ({
  accountId,
  accessToken,
  text,
  mediaUrls = [],
  contentType = 'text',
  requestHost = null,
}) => {
  if (!accountId || !accessToken) {
    throw asHttpError(400, 'Threads account is not fully connected', 'THREADS_ACCOUNT_INCOMPLETE');
  }
  const liveAccountId = await resolveLiveThreadsAccountId({ accountId, accessToken });
  if (!liveAccountId) {
    throw asHttpError(400, 'Threads account id is missing. Reconnect Threads account.', 'THREADS_ACCOUNT_INCOMPLETE');
  }

  const normalizedText = String(text || '').trim();
  if (normalizedText && normalizedText.length > THREADS_TEXT_MAX_CHARS) {
    throw asHttpError(400, `Threads text must be ${THREADS_TEXT_MAX_CHARS} characters or fewer`, 'THREADS_TEXT_TOO_LONG');
  }

  const normalizedType = String(contentType || 'text').toLowerCase();
  let mediaType = 'TEXT';
  let imageUrl = null;
  let videoUrl = null;

  if (normalizedType === 'image') {
    const media = mediaUrls[0];
    if (!media) {
      throw asHttpError(400, 'Threads image post requires one media file', 'THREADS_IMAGE_REQUIRED');
    }
    imageUrl = resolvePublicMediaUrl(media, requestHost);
    mediaType = 'IMAGE';
  } else if (normalizedType === 'video') {
    const media = mediaUrls[0];
    if (!media) {
      throw asHttpError(400, 'Threads video post requires one media file', 'THREADS_VIDEO_REQUIRED');
    }
    videoUrl = resolvePublicMediaUrl(media, requestHost);
    if (!isVideoUrl(videoUrl)) {
      throw asHttpError(400, 'Threads video post requires a video URL (.mp4/.mov)', 'THREADS_VIDEO_INVALID');
    }
    mediaType = 'VIDEO';
  }

  let container;
  try {
    container = await createThreadsContainer({
      accountId: liveAccountId,
      accessToken,
      mediaType,
      text: normalizedText,
      imageUrl,
      videoUrl,
      replyToId: null,
    });
  } catch (error) {
    if (isMissingResourceError(error)) {
      throw asHttpError(
        400,
        'Threads account resource not found for current token. Reconnect Threads and try again.',
        'THREADS_ACCOUNT_RESOURCE_NOT_FOUND'
      );
    }
    throw error;
  }

  if (!container?.id) {
    throw asHttpError(400, 'Threads container creation failed', 'THREADS_CONTAINER_FAILED');
  }

  if (mediaType === 'VIDEO') {
    await waitForVideoContainer(container.id, accessToken);
  }

  const publish = await publishThreadsContainerWithRetry({
    accountId: liveAccountId,
    accessToken,
    creationId: container.id,
  });

  return {
    creationId: container.id,
    publishId: publish?.id || null,
  };
};

export const publishThreadsThread = async ({
  accountId,
  accessToken,
  posts,
}) => {
  if (!accountId || !accessToken) {
    throw asHttpError(400, 'Threads account is not fully connected', 'THREADS_ACCOUNT_INCOMPLETE');
  }
  const liveAccountId = await resolveLiveThreadsAccountId({ accountId, accessToken });
  if (!liveAccountId) {
    throw asHttpError(400, 'Threads account id is missing. Reconnect Threads account.', 'THREADS_ACCOUNT_INCOMPLETE');
  }

  if (!Array.isArray(posts) || posts.length < 2) {
    throw asHttpError(400, 'Threads chain requires at least 2 posts', 'THREADS_CHAIN_MIN_POSTS');
  }

  const normalizedPosts = posts
    .map((post) => String(post || '').trim())
    .filter(Boolean);

  if (normalizedPosts.length < 2) {
    throw asHttpError(400, 'Threads chain requires at least 2 non-empty posts', 'THREADS_CHAIN_MIN_POSTS');
  }

  const tooLongPost = normalizedPosts.find((post) => post.length > THREADS_TEXT_MAX_CHARS);
  if (tooLongPost) {
    throw asHttpError(
      400,
      `Each thread post must be ${THREADS_TEXT_MAX_CHARS} characters or fewer`,
      'THREADS_POST_TOO_LONG'
    );
  }

  const publishedIds = [];
  let replyToId = null;

  for (const text of normalizedPosts) {
    let container;
    try {
      container = await createThreadsContainer({
        accountId: liveAccountId,
        accessToken,
        mediaType: 'TEXT',
        text,
        replyToId,
      });
    } catch (error) {
      if (isMissingResourceError(error)) {
        throw asHttpError(
          400,
          'Threads account resource not found for current token. Reconnect Threads and try again.',
          'THREADS_ACCOUNT_RESOURCE_NOT_FOUND'
        );
      }
      throw error;
    }

    if (!container?.id) {
      throw asHttpError(400, 'Failed to create Threads chain container', 'THREADS_CHAIN_CONTAINER_FAILED');
    }

    const publish = await publishThreadsContainerWithRetry({
      accountId: liveAccountId,
      accessToken,
      creationId: container.id,
    });

    const threadId = publish?.id;
    if (!threadId) {
      throw asHttpError(400, 'Failed to publish Threads chain post', 'THREADS_CHAIN_PUBLISH_FAILED');
    }

    publishedIds.push(String(threadId));
    replyToId = String(threadId);
  }

  return {
    publishId: publishedIds[0],
    threadPostIds: publishedIds,
  };
};
