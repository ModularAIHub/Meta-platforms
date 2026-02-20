const PERMISSION_PATTERNS = [
  /application does not have permission/i,
  /not authorized/i,
  /permissions? error/i,
  /permission denied/i,
  /insufficient permissions?/i,
];

const TOKEN_EXPIRED_PATTERNS = [
  /token.*expired/i,
  /session has expired/i,
  /invalid oauth access token/i,
  /error validating access token/i,
];

const RESOURCE_NOT_FOUND_PATTERNS = [
  /requested resource does not exist/i,
  /unsupported get request/i,
  /resource not found/i,
];

const toError = (status, message, code) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

export const extractProviderErrorMessage = (error) =>
  error?.response?.data?.error?.message ||
  error?.response?.data?.message ||
  error?.message ||
  '';

export const mapSocialPublishError = (error, { platform = null } = {}) => {
  if (error && Number.isInteger(error.status) && typeof error.message === 'string' && error.code) {
    return error;
  }

  const providerMessage = extractProviderErrorMessage(error) || 'Unknown publish failure';

  if (TOKEN_EXPIRED_PATTERNS.some((pattern) => pattern.test(providerMessage))) {
    if (platform === 'threads') {
      return toError(400, 'Threads token expired. Reconnect Threads and try again.', 'THREADS_TOKEN_EXPIRED');
    }
    if (platform === 'instagram') {
      return toError(400, 'Instagram token expired. Reconnect Instagram and try again.', 'INSTAGRAM_TOKEN_EXPIRED');
    }
    if (platform === 'youtube') {
      return toError(400, 'YouTube token expired. Reconnect YouTube and try again.', 'YOUTUBE_TOKEN_EXPIRED');
    }
  }

  if (PERMISSION_PATTERNS.some((pattern) => pattern.test(providerMessage))) {
    if (platform === 'threads') {
      return toError(
        400,
        'Threads publish permission missing. Ensure threads_content_publish is enabled, your account is a Threads tester, then reconnect Threads.',
        'THREADS_PERMISSION_MISSING'
      );
    }

    if (platform === 'instagram') {
      return toError(
        400,
        'Instagram publish permission missing. Ensure Instagram publish scopes are enabled and reconnect Instagram.',
        'INSTAGRAM_PERMISSION_MISSING'
      );
    }

    if (platform === 'youtube') {
      return toError(
        400,
        'YouTube publish permission missing. Ensure upload scope is granted and reconnect YouTube.',
        'YOUTUBE_PERMISSION_MISSING'
      );
    }

    return toError(400, 'Publish permission missing. Reconnect account with required scopes.', 'SOCIAL_PERMISSION_MISSING');
  }

  if (RESOURCE_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(providerMessage))) {
    if (platform === 'threads') {
      return toError(400, 'Threads resource not found for this token. Reconnect Threads and retry.', 'THREADS_RESOURCE_NOT_FOUND');
    }
    if (platform === 'instagram') {
      return toError(400, 'Instagram resource not found for this token. Reconnect Instagram and retry.', 'INSTAGRAM_RESOURCE_NOT_FOUND');
    }
    if (platform === 'youtube') {
      return toError(400, 'YouTube channel/resource not found for this token. Reconnect YouTube and retry.', 'YOUTUBE_RESOURCE_NOT_FOUND');
    }
  }

  return toError(400, `Social publish failed: ${providerMessage}`, 'SOCIAL_PUBLISH_FAILED');
};
