const normalizeValue = (value) => String(value || '').trim();
const normalizeLower = (value) => normalizeValue(value).toLowerCase();

const parseBooleanEnv = (value, fallback = false) => {
  const normalized = normalizeLower(value);
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
};

const parseCsvEnvList = (value, { lowerCase = false } = {}) =>
  normalizeValue(value)
    .split(/[,\n]/)
    .map((item) => (lowerCase ? normalizeLower(item) : normalizeValue(item)))
    .filter(Boolean);

const normalizePlatformMode = (value) => normalizeLower(value);

export const resolveSocialPlatformMode = () => {
  const explicitMode = normalizePlatformMode(process.env.SOCIAL_PLATFORM_MODE);
  if (explicitMode === 'all' || explicitMode === 'threads_only') {
    return explicitMode;
  }

  // Safer production default: keep Threads live, hold Instagram/YouTube until enabled.
  return process.env.NODE_ENV === 'production' ? 'threads_only' : 'all';
};

export const SOCIAL_PLATFORM_MODE = resolveSocialPlatformMode();

const BASE_ENABLED_SOCIAL_PLATFORMS = SOCIAL_PLATFORM_MODE === 'threads_only'
  ? new Set(['threads'])
  : new Set(['instagram', 'youtube', 'threads']);

export const INSTAGRAM_INVITE_ONLY_ENABLED = SOCIAL_PLATFORM_MODE === 'threads_only'
  ? parseBooleanEnv(process.env.INSTAGRAM_INVITE_ONLY_ENABLED, true)
  : false;

const INSTAGRAM_INVITE_TESTER_EMAILS = new Set(
  parseCsvEnvList(process.env.INSTAGRAM_INVITE_TESTER_EMAILS, { lowerCase: true })
);

const INSTAGRAM_INVITE_TESTER_USER_IDS = new Set(
  parseCsvEnvList(process.env.INSTAGRAM_INVITE_TESTER_USER_IDS)
);

export const isInstagramInviteTester = (user = null) => {
  const email = normalizeLower(user?.email);
  const userId = normalizeValue(user?.id);

  return (
    (email && INSTAGRAM_INVITE_TESTER_EMAILS.has(email)) ||
    (userId && INSTAGRAM_INVITE_TESTER_USER_IDS.has(userId))
  );
};

export const isSocialPlatformEnabledForUser = (platform, user = null) => {
  const normalizedPlatform = normalizeLower(platform);
  if (!normalizedPlatform) return false;

  if (BASE_ENABLED_SOCIAL_PLATFORMS.has(normalizedPlatform)) {
    return true;
  }

  if (normalizedPlatform !== 'instagram') {
    return false;
  }

  return INSTAGRAM_INVITE_ONLY_ENABLED && isInstagramInviteTester(user);
};

export const getDisabledSocialPlatformsForUser = (platforms = [], user = null) =>
  platforms.filter((platform) => !isSocialPlatformEnabledForUser(platform, user));

export const getPlatformModeErrorPayload = ({ platforms = [], user = null } = {}) => {
  const disabledPlatforms = getDisabledSocialPlatformsForUser(platforms, user);
  if (disabledPlatforms.length === 0) {
    return null;
  }

  const instagramInviteOnlyBlocked =
    disabledPlatforms.length === 1 &&
    disabledPlatforms[0] === 'instagram' &&
    SOCIAL_PLATFORM_MODE === 'threads_only' &&
    INSTAGRAM_INVITE_ONLY_ENABLED;

  if (instagramInviteOnlyBlocked) {
    return {
      error: 'Instagram is currently invite-only for approved testers. Ask for tester access to enable Instagram posting.',
      code: 'PLATFORM_DISABLED_IN_MODE',
      reason: 'instagram_invite_only',
    };
  }

  return {
    error: `Platform(s) disabled for this deployment mode (${SOCIAL_PLATFORM_MODE}): ${disabledPlatforms.join(', ')}`,
    code: 'PLATFORM_DISABLED_IN_MODE',
  };
};
