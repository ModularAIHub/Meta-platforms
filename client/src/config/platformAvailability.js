const normalizeMode = (value) => String(value || '').trim().toLowerCase();

const resolvePlatformMode = () => {
  const explicitMode = normalizeMode(import.meta.env.VITE_SOCIAL_PLATFORM_MODE);
  if (explicitMode === 'all' || explicitMode === 'threads_only') {
    return explicitMode;
  }

  // Default production behavior for the Meta app domain.
  if (typeof window !== 'undefined' && window.location.hostname === 'meta.suitegenie.in') {
    return 'threads_only';
  }

  return 'all';
};

export const SOCIAL_PLATFORM_MODE = resolvePlatformMode();
export const IS_THREADS_ONLY_MODE = SOCIAL_PLATFORM_MODE === 'threads_only';

export const ENABLED_SOCIAL_PLATFORMS = IS_THREADS_ONLY_MODE
  ? ['threads']
  : ['instagram', 'threads', 'youtube'];

export const isSocialPlatformEnabled = (platform) =>
  ENABLED_SOCIAL_PLATFORMS.includes(String(platform || '').toLowerCase());

export const THREADS_INVITE_MODE_NOTICE =
  'Threads is currently invite-only while Meta app review is in progress.';
