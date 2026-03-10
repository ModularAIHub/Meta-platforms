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

  if (!IS_THREADS_ONLY_MODE) {
    return ['instagram', 'threads', 'youtube'].includes(normalizedPlatform);
  }

  if (normalizedPlatform === 'threads') {
    return true;
  }

  if (normalizedPlatform === 'instagram') {
    return INSTAGRAM_INVITE_ONLY_ENABLED && isInstagramInviteTester(context);
  }

  return false;
};

export const getSocialPlatformUnavailableMessage = (platform) => {
  const normalizedPlatform = normalizeLower(platform);
  if (normalizedPlatform === 'instagram' && IS_THREADS_ONLY_MODE && INSTAGRAM_INVITE_ONLY_ENABLED) {
    return 'Instagram is in invite-only testing for approved accounts right now.';
  }
  return 'This platform is not available in production yet.';
};

export const ENABLED_SOCIAL_PLATFORMS = IS_THREADS_ONLY_MODE
  ? (INSTAGRAM_INVITE_ONLY_ENABLED ? ['threads', 'instagram'] : ['threads'])
  : ['instagram', 'threads', 'youtube'];

export const THREADS_INVITE_MODE_NOTICE = INSTAGRAM_INVITE_ONLY_ENABLED
  ? 'Threads is live. Instagram is invite-only for approved testers, and YouTube remains disabled in production.'
  : 'Threads is live. Instagram and YouTube remain disabled in production until their rollout is enabled.';
