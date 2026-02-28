import express from 'express';
import { logger } from '../utils/logger.js';

const router = express.Router();

const INTERNAL_CALLER = 'social-genie';
const CROSSPOST_STATUS_TIMEOUT_MS = Number.parseInt(
  process.env.CROSSPOST_STATUS_TIMEOUT_MS || '5000',
  10
);

const buildInternalServiceEndpoint = (baseUrl, path) =>
  `${String(baseUrl || '').trim().replace(/\/$/, '')}${path}`;

const mapUpstreamFailureReason = (status, code = '') => {
  const normalizedCode = String(code || '').toUpperCase();
  if (status === 404 || normalizedCode.includes('NOT_CONNECTED')) return 'not_connected';
  if (status === 401 || normalizedCode.includes('TOKEN_EXPIRED')) return 'token_expired';
  return 'service_unreachable';
};

const fetchJson = async ({ endpoint, headers = {}, timeoutMs = CROSSPOST_STATUS_TIMEOUT_MS }) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...headers,
      },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } finally {
    clearTimeout(timeoutId);
  }
};

const resolveXStatus = async ({ userId, teamId }) => {
  const tweetGenieUrl = String(process.env.TWEET_GENIE_URL || '').trim();
  const internalApiKey = String(process.env.INTERNAL_API_KEY || '').trim();

  if (!tweetGenieUrl || !internalApiKey) {
    return { connected: false, reason: 'not_configured', account: null };
  }

  try {
    const endpoint = buildInternalServiceEndpoint(tweetGenieUrl, '/api/internal/twitter/targets');
    const { response, body } = await fetchJson({
      endpoint,
      headers: {
        'x-internal-api-key': internalApiKey,
        'x-internal-caller': INTERNAL_CALLER,
        'x-platform-user-id': String(userId),
        ...(teamId ? { 'x-platform-team-id': String(teamId) } : {}),
      },
    });

    if (!response.ok) {
      return {
        connected: false,
        reason: mapUpstreamFailureReason(response.status, body?.code),
        account: null,
        accounts: [],
      };
    }

    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    return {
      connected: accounts.length > 0,
      reason: accounts.length > 0 ? null : 'not_connected',
      account: accounts[0] || null,
      accounts,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { connected: false, reason: 'timeout', account: null, accounts: [] };
    }

    logger.warn('[cross-post/status] Failed to fetch X status', {
      userId,
      teamId: teamId || null,
      error: error?.message || String(error),
    });
    return { connected: false, reason: 'service_unreachable', account: null, accounts: [] };
  }
};

const resolveLinkedInStatus = async ({ userId, teamId }) => {
  const linkedInGenieUrl = String(process.env.LINKEDIN_GENIE_URL || '').trim();
  const internalApiKey = String(process.env.INTERNAL_API_KEY || '').trim();

  if (!linkedInGenieUrl || !internalApiKey) {
    return { connected: false, reason: 'not_configured', account: null };
  }

  try {
    const endpoint = buildInternalServiceEndpoint(linkedInGenieUrl, '/api/internal/accounts/targets');
    const { response, body } = await fetchJson({
      endpoint,
      headers: {
        'x-internal-api-key': internalApiKey,
        'x-internal-caller': INTERNAL_CALLER,
        'x-platform-user-id': String(userId),
        ...(teamId ? { 'x-platform-team-id': String(teamId) } : {}),
      },
    });

    if (!response.ok) {
      return {
        connected: false,
        reason: mapUpstreamFailureReason(response.status, body?.code),
        account: null,
        accounts: [],
      };
    }

    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    const primary = accounts[0] || null;

    return {
      connected: accounts.length > 0,
      reason: accounts.length > 0 ? null : 'not_connected',
      account: primary,
      accounts,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { connected: false, reason: 'timeout', account: null, accounts: [] };
    }

    logger.warn('[cross-post/status] Failed to fetch LinkedIn status', {
      userId,
      teamId: teamId || null,
      error: error?.message || String(error),
    });
    return { connected: false, reason: 'service_unreachable', account: null, accounts: [] };
  }
};

router.get('/status', async (req, res) => {
  const userId = req.user?.id || req.user?.userId;
  const teamId =
    req.teamContext?.isTeamMember && req.teamContext?.teamId ? req.teamContext.teamId : null;

  if (!userId) {
    return res.status(401).json({
      error: 'Not authenticated',
      code: 'UNAUTHORIZED',
    });
  }

  const [xStatus, linkedinStatus] = await Promise.all([
    resolveXStatus({ userId, teamId }),
    resolveLinkedInStatus({ userId, teamId }),
  ]);

  const teamMode = Boolean(teamId);
  const withAvailability = (status) => ({
    ...status,
    available: status.connected === true,
    restriction: null,
  });

  return res.json({
    source: 'threads',
    teamMode,
    targets: {
      x: withAvailability(xStatus),
      linkedin: withAvailability(linkedinStatus),
    },
  });
});

export default router;
