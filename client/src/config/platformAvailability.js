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

const resolvePlatformMode = () => {
  const explicitMode = normalizeLower(import.meta.env.VITE_SOCIAL_PLATFORM_MODE);
  if (explicitMode === 'all' || explicitMode === 'threads_only') {
    return explicitMode;
  }

  if (import.meta.env.PROD) {
    return 'threads_only';
  }

  // Default production behavior for the Meta app domain.
  if (typeof window !== 'undefined' && window.location.hostname === 'meta.suitegenie.in') {
    return 'threads_only';
  }

  return 'all';
};

const normalizeAccessContext = (context = null) => ({
  email: normalizeLower(context?.email),
  id: normalizeValue(context?.id),
});

export const SOCIAL_PLATFORM_MODE = resolvePlatformMode();
export const IS_THREADS_ONLY_MODE = SOCIAL_PLATFORM_MODE === 'threads_only';
export const INSTAGRAM_INVITE_ONLY_ENABLED = IS_THREADS_ONLY_MODE
  ? parseBooleanEnv(import.meta.env.VITE_INSTAGRAM_INVITE_ONLY_ENABLED, true)
  : false;
export const INSTAGRAM_ENABLED = !IS_THREADS_ONLY_MODE
  ? true
  : parseBooleanEnv(import.meta.env.VITE_INSTAGRAM_ENABLED, false);
export const YOUTUBE_ENABLED = !IS_THREADS_ONLY_MODE
  ? true
  : parseBooleanEnv(import.meta.env.VITE_YOUTUBE_ENABLED, false);

const INSTAGRAM_INVITE_TESTER_EMAILS = new Set(
  parseCsvEnvList(import.meta.env.VITE_INSTAGRAM_INVITE_TESTER_EMAILS, { lowerCase: true })
);
const INSTAGRAM_INVITE_TESTER_USER_IDS = new Set(
  parseCsvEnvList(import.meta.env.VITE_INSTAGRAM_INVITE_TESTER_USER_IDS)
);

export const isInstagramInviteTester = (context = null) => {
  const normalized = normalizeAccessContext(context);
  return (
    (normalized.email && INSTAGRAM_INVITE_TESTER_EMAILS.has(normalized.email)) ||
    (normalized.id && INSTAGRAM_INVITE_TESTER_USER_IDS.has(normalized.id))
  );
};

export const isSocialPlatformEnabled = (platform, context = null) => {
  const normalizedPlatform = normalizeLower(platform);
  if (!normalizedPlatform) return false;

  if (normalizedPlatform === 'threads') {
    return true;
  }

  if (normalizedPlatform === 'instagram') {
    if (INSTAGRAM_ENABLED) {
      return true;
    }
    return INSTAGRAM_INVITE_ONLY_ENABLED && isInstagramInviteTester(context);
  }

  if (normalizedPlatform === 'youtube') {
    return YOUTUBE_ENABLED;
  }

  return !IS_THREADS_ONLY_MODE && ['instagram', 'threads', 'youtube'].includes(normalizedPlatform);
};

export const getSocialPlatformUnavailableMessage = (platform) => {
  const normalizedPlatform = normalizeLower(platform);
  if (normalizedPlatform === 'instagram' && IS_THREADS_ONLY_MODE && !INSTAGRAM_ENABLED && INSTAGRAM_INVITE_ONLY_ENABLED) {
    return 'Instagram is in invite-only testing for approved accounts right now.';
  }
  if (normalizedPlatform === 'youtube' && !YOUTUBE_ENABLED) {
    return 'YouTube is disabled for this deployment until the rollout envs are enabled.';
  }
  return 'This platform is not available in production yet.';
};

export const ENABLED_SOCIAL_PLATFORMS = [
  'threads',
  ...(INSTAGRAM_ENABLED || INSTAGRAM_INVITE_ONLY_ENABLED ? ['instagram'] : []),
  ...(YOUTUBE_ENABLED ? ['youtube'] : []),
];

const rolloutNoticeParts = ['Threads is live.'];
if (INSTAGRAM_ENABLED) {
  rolloutNoticeParts.push('Instagram is enabled.');
} else if (INSTAGRAM_INVITE_ONLY_ENABLED) {
  rolloutNoticeParts.push('Instagram is invite-only for approved testers.');
} else {
  rolloutNoticeParts.push('Instagram remains disabled until rollout is enabled.');
}
if (YOUTUBE_ENABLED) {
  rolloutNoticeParts.push('YouTube is enabled.');
} else {
  rolloutNoticeParts.push('YouTube remains disabled until rollout envs are enabled.');
}

export const THREADS_INVITE_MODE_NOTICE = rolloutNoticeParts.join(' ');
