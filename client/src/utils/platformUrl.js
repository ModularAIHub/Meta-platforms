export const resolvePlatformBaseUrl = () => {
  const configured = import.meta.env.VITE_PLATFORM_URL;
  if (configured && String(configured).trim()) {
    return String(configured).trim().replace(/\/$/, '');
  }

  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'http://localhost:5173';
    }
  }

  return 'https://suitegenie.in';
};

export const buildPlatformLoginUrl = (redirectUrl) => {
  const base = resolvePlatformBaseUrl();
  const redirect = encodeURIComponent(redirectUrl);
  return `${base}/login?redirect=${redirect}`;
};
