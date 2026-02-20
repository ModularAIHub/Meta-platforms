import axios from 'axios';

const INSTAGRAM_API_VERSION = process.env.INSTAGRAM_API_VERSION || 'v23.0';
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

const getPublicBaseUrl = () => String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || '').trim();

const joinUrl = (base, path) => {
  const cleanBase = String(base || '').replace(/\/$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
};

const resolvePublicMediaUrl = (inputUrl, requestHost = null) => {
  const value = String(inputUrl || '').trim();
  if (!value) {
    throw asHttpError(400, 'Media URL is required for Instagram publishing', 'MEDIA_URL_REQUIRED');
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

const postGraph = async (path, params) => {
  const endpoint = `https://graph.facebook.com/${INSTAGRAM_API_VERSION}${path}`;

  const payload = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      payload.append(key, String(value));
    }
  });

  const response = await axios.post(endpoint, payload.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 25000,
  });

  return response.data;
};

const getGraph = async (path, params) => {
  const endpoint = `https://graph.facebook.com/${INSTAGRAM_API_VERSION}${path}`;
  const response = await axios.get(endpoint, {
    params,
    timeout: 15000,
  });
  return response.data;
};

const waitUntilContainerReady = async (containerId, accessToken) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const status = await getGraph(`/${containerId}`, {
      fields: 'status_code,status',
      access_token: accessToken,
    });

    const code = String(status?.status_code || status?.status || '').toUpperCase();

    if (code === 'FINISHED' || code === 'PUBLISHED' || code === 'READY') {
      return;
    }

    if (code === 'ERROR' || code === 'EXPIRED') {
      throw asHttpError(400, `Instagram media processing failed (${code})`, 'INSTAGRAM_MEDIA_PROCESSING_FAILED');
    }

    await sleep(3000);
  }

  throw asHttpError(408, 'Instagram media processing timed out', 'INSTAGRAM_MEDIA_PROCESSING_TIMEOUT');
};

const createContainerForSinglePost = async ({ accountId, accessToken, mediaUrl, caption, contentType }) => {
  const isVideo = isVideoUrl(mediaUrl);
  const normalizedType = String(contentType || 'feed').toLowerCase();

  if (normalizedType === 'reel' && !isVideo) {
    throw asHttpError(400, 'Reel publishing requires a video URL (.mp4/.mov)', 'INSTAGRAM_REEL_VIDEO_REQUIRED');
  }

  const params = {
    access_token: accessToken,
  };

  if (normalizedType === 'reel') {
    params.media_type = 'REELS';
    params.video_url = mediaUrl;
    params.caption = caption;
  } else if (normalizedType === 'story') {
    params.media_type = 'STORIES';
    if (isVideo) {
      params.video_url = mediaUrl;
    } else {
      params.image_url = mediaUrl;
    }
  } else if (isVideo) {
    params.media_type = 'VIDEO';
    params.video_url = mediaUrl;
    params.caption = caption;
  } else {
    params.image_url = mediaUrl;
    params.caption = caption;
  }

  const container = await postGraph(`/${accountId}/media`, params);
  const needsPolling = normalizedType === 'reel' || normalizedType === 'story' || isVideo;

  if (needsPolling) {
    await waitUntilContainerReady(container.id, accessToken);
  }

  return container.id;
};

const publishCarousel = async ({ accountId, accessToken, mediaUrls, caption }) => {
  if (!Array.isArray(mediaUrls) || mediaUrls.length < 2) {
    throw asHttpError(400, 'Carousel requires at least 2 media URLs', 'INSTAGRAM_CAROUSEL_MIN_ITEMS');
  }

  const childContainerIds = [];

  for (const url of mediaUrls) {
    const video = isVideoUrl(url);
    const params = {
      access_token: accessToken,
      is_carousel_item: 'true',
    };

    if (video) {
      params.media_type = 'VIDEO';
      params.video_url = url;
    } else {
      params.image_url = url;
    }

    const container = await postGraph(`/${accountId}/media`, params);
    childContainerIds.push(container.id);

    if (video) {
      await waitUntilContainerReady(container.id, accessToken);
    }
  }

  const parent = await postGraph(`/${accountId}/media`, {
    access_token: accessToken,
    media_type: 'CAROUSEL',
    children: childContainerIds.join(','),
    caption,
  });

  await waitUntilContainerReady(parent.id, accessToken);

  const publish = await postGraph(`/${accountId}/media_publish`, {
    access_token: accessToken,
    creation_id: parent.id,
  });

  return {
    creationId: parent.id,
    publishId: publish.id,
  };
};

export const publishInstagramPost = async ({
  accountId,
  accessToken,
  mediaUrls,
  caption,
  contentType = 'feed',
  requestHost = null,
}) => {
  if (!accountId || !accessToken) {
    throw asHttpError(400, 'Instagram account is not fully connected', 'INSTAGRAM_ACCOUNT_INCOMPLETE');
  }

  if (!Array.isArray(mediaUrls) || mediaUrls.length === 0) {
    throw asHttpError(400, 'At least one media file is required for Instagram posting', 'INSTAGRAM_MEDIA_REQUIRED');
  }

  const publicUrls = mediaUrls.map((url) => resolvePublicMediaUrl(url, requestHost));
  const normalizedType = String(contentType || 'feed').toLowerCase();

  if (normalizedType === 'carousel') {
    return publishCarousel({
      accountId,
      accessToken,
      mediaUrls: publicUrls,
      caption,
    });
  }

  const containerId = await createContainerForSinglePost({
    accountId,
    accessToken,
    mediaUrl: publicUrls[0],
    caption,
    contentType: normalizedType,
  });

  const publish = await postGraph(`/${accountId}/media_publish`, {
    access_token: accessToken,
    creation_id: containerId,
  });

  return {
    creationId: containerId,
    publishId: publish.id,
  };
};
