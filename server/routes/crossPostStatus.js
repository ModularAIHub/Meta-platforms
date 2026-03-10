import express from 'express';
import { pool } from '../config/database.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

const INTERNAL_CALLER = 'social-genie';
const CROSSPOST_STATUS_TIMEOUT_MS = Number.parseInt(
  process.env.CROSSPOST_STATUS_TIMEOUT_MS || '5000',
  10
);

/* ───────────────── helpers ───────────────── */

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

const buildAccountsPayload = (accounts) => ({
  connected: accounts.length > 0,
  reason: accounts.length > 0 ? null : 'not_connected',
  account: accounts[0] || null,
  accounts,
});

/* ───────────────── local X (Twitter) targets ───────────────── */

const mapLocalXAccount = (row = {}) => {
  const id =
    row?.source_id !== undefined && row?.source_id !== null
      ? String(row.source_id)
      : row?.id !== undefined && row?.id !== null
        ? String(row.id)
        : null;
  const username = String(row?.twitter_username || row?.account_username || '').trim();
  const displayName =
    String(row?.twitter_display_name || row?.account_display_name || '').trim() ||
    (username ? `@${username}` : 'X account');

  return {
    id,
    platform: 'twitter',
    accountId: row?.twitter_user_id || row?.account_id ? String(row.twitter_user_id || row.account_id) : null,
    username: username || null,
    displayName,
    avatar: row?.twitter_profile_image_url || row?.profile_image_url || null,
    supportsMediaUpload: Boolean(
      row?.has_oauth1 ||
      (row?.oauth1_access_token && row?.oauth1_access_token_secret)
    ),
  };
};

const listLocalXTargets = async ({ userId, teamId = null }) => {
  const normalizedUserId = String(userId || '').trim();
  const normalizedTeamId = String(teamId || '').trim() || null;
  if (!normalizedUserId) return [];

  // 1️⃣ Try cross-platform registry (social_connected_accounts)
  try {
    const { rows } = await pool.query(
      normalizedTeamId
        ? `SELECT
             sca.id::text,
             COALESCE(NULLIF(sca.metadata->>'source_id', ''), sca.id::text) AS source_id,
             sca.account_id,
             sca.account_username,
             sca.account_display_name,
             sca.profile_image_url,
             COALESCE((sca.metadata->>'has_oauth1')::boolean, false) AS has_oauth1
           FROM social_connected_accounts sca
           INNER JOIN team_members tm
             ON tm.team_id::text = sca.team_id::text
            AND tm.user_id = $1
            AND tm.status = 'active'
           WHERE sca.team_id::text = $2::text
             AND sca.platform = 'twitter'
             AND sca.is_active = true
           ORDER BY
             CASE WHEN COALESCE((sca.metadata->>'has_oauth1')::boolean, false) THEN 0 ELSE 1 END,
             sca.updated_at DESC NULLS LAST, sca.id DESC`
        : `SELECT
             sca.id::text,
             COALESCE(NULLIF(sca.metadata->>'source_id', ''), sca.id::text) AS source_id,
             sca.account_id,
             sca.account_username,
             sca.account_display_name,
             sca.profile_image_url,
             COALESCE((sca.metadata->>'has_oauth1')::boolean, false) AS has_oauth1
           FROM social_connected_accounts sca
           WHERE sca.user_id = $1
             AND sca.team_id IS NULL
             AND sca.platform = 'twitter'
             AND sca.is_active = true
           ORDER BY
             CASE WHEN COALESCE((sca.metadata->>'has_oauth1')::boolean, false) THEN 0 ELSE 1 END,
             sca.updated_at DESC NULLS LAST, sca.id DESC`,
      normalizedTeamId ? [normalizedUserId, normalizedTeamId] : [normalizedUserId]
    );

    if (rows.length > 0) {
      return rows.map(mapLocalXAccount).filter((a) => a.id);
    }
  } catch (error) {
    logger.warn('[cross-post/local] social_connected_accounts lookup failed for twitter', {
      userId: normalizedUserId,
      teamId: normalizedTeamId,
      error: error?.message || String(error),
    });
  }

  // 2️⃣ Fallback to platform-specific tables
  try {
    const { rows } = await pool.query(
      normalizedTeamId
        ? `SELECT ta.id::text, ta.twitter_user_id, ta.twitter_username,
                  ta.twitter_display_name, ta.twitter_profile_image_url,
                  ta.oauth1_access_token, ta.oauth1_access_token_secret
           FROM team_accounts ta
           INNER JOIN team_members tm
             ON tm.team_id = ta.team_id
            AND tm.user_id = $1
            AND tm.status = 'active'
           WHERE ta.team_id::text = $2::text
             AND ta.active = true
           ORDER BY
             CASE WHEN ta.oauth1_access_token IS NOT NULL AND ta.oauth1_access_token_secret IS NOT NULL THEN 0 ELSE 1 END,
             ta.updated_at DESC NULLS LAST, ta.id DESC`
        : `SELECT id::text, twitter_user_id, twitter_username,
                  twitter_display_name, twitter_profile_image_url,
                  oauth1_access_token, oauth1_access_token_secret
           FROM twitter_auth
           WHERE user_id = $1
           ORDER BY
             CASE WHEN oauth1_access_token IS NOT NULL AND oauth1_access_token_secret IS NOT NULL THEN 0 ELSE 1 END,
             updated_at DESC NULLS LAST, id DESC`,
      normalizedTeamId ? [normalizedUserId, normalizedTeamId] : [normalizedUserId]
    );

    return rows.map(mapLocalXAccount).filter((a) => a.id);
  } catch (error) {
    logger.warn('[cross-post/local] platform-table lookup failed for twitter', {
      userId: normalizedUserId,
      teamId: normalizedTeamId,
      error: error?.message || String(error),
    });
    return [];
  }
};

/* ───────────────── local LinkedIn targets ───────────────── */

const mapLocalLinkedInAccount = (row = {}) => {
  const id = row?.id !== undefined && row?.id !== null ? String(row.id) : null;
  const username = String(
    row?.account_username || row?.linkedin_username || row?.linkedin_user_id || ''
  ).trim();
  const displayName =
    String(row?.account_display_name || row?.linkedin_display_name || '').trim() ||
    (username ? username : 'LinkedIn account');

  return {
    id,
    platform: 'linkedin',
    username: username || null,
    displayName,
    avatar: row?.profile_image_url || row?.linkedin_profile_image_url || null,
  };
};

const listLocalLinkedInTargets = async ({ userId, teamId = null }) => {
  const normalizedUserId = String(userId || '').trim();
  const normalizedTeamId = String(teamId || '').trim() || null;
  if (!normalizedUserId) return [];

  // 1️⃣ Cross-platform registry
  try {
    const { rows } = await pool.query(
      normalizedTeamId
        ? `SELECT sca.id::text, sca.account_username, sca.account_display_name, sca.profile_image_url
           FROM social_connected_accounts sca
           INNER JOIN team_members tm
             ON tm.team_id::text = sca.team_id::text
            AND tm.user_id = $1
            AND tm.status = 'active'
           WHERE sca.team_id::text = $2::text
             AND sca.platform = 'linkedin'
             AND sca.is_active = true
           ORDER BY sca.account_display_name ASC NULLS LAST, sca.id DESC`
        : `SELECT id::text, account_username, account_display_name, profile_image_url
           FROM social_connected_accounts
           WHERE user_id = $1
             AND team_id IS NULL
             AND platform = 'linkedin'
             AND is_active = true
           ORDER BY account_display_name ASC NULLS LAST, id DESC`,
      normalizedTeamId ? [normalizedUserId, normalizedTeamId] : [normalizedUserId]
    );

    if (rows.length > 0) {
      return rows.map(mapLocalLinkedInAccount).filter((a) => a.id);
    }
  } catch (error) {
    logger.warn('[cross-post/local] social_connected_accounts lookup failed for linkedin', {
      userId: normalizedUserId,
      teamId: normalizedTeamId,
      error: error?.message || String(error),
    });
  }

  // 2️⃣ Fallback to linkedin_auth (personal only)
  if (!normalizedTeamId) {
    try {
      const { rows } = await pool.query(
        `SELECT id::text, linkedin_user_id, linkedin_username,
                linkedin_display_name, linkedin_profile_image_url
         FROM linkedin_auth
         WHERE user_id = $1
         ORDER BY updated_at DESC NULLS LAST, id DESC`,
        [normalizedUserId]
      );

      return rows.map(mapLocalLinkedInAccount).filter((a) => a.id);
    } catch (error) {
      logger.warn('[cross-post/local] linkedin_auth lookup failed', {
        userId: normalizedUserId,
        error: error?.message || String(error),
      });
    }
  }

  // 2b️⃣ Fallback for team: linkedin_accounts (LinkedIn Genie's table)
  if (normalizedTeamId) {
    try {
      const { rows } = await pool.query(
        `SELECT la.id::text, la.linkedin_user_id, la.linkedin_username,
                la.display_name AS linkedin_display_name,
                la.profile_image_url AS linkedin_profile_image_url
         FROM linkedin_accounts la
         INNER JOIN team_members tm
           ON tm.team_id::text = la.team_id::text
          AND tm.user_id = $1
          AND tm.status = 'active'
         WHERE la.team_id::text = $2::text
         ORDER BY la.display_name ASC NULLS LAST, la.id DESC`,
        [normalizedUserId, normalizedTeamId]
      );

      return rows.map(mapLocalLinkedInAccount).filter((a) => a.id);
    } catch (error) {
      // Table may not exist — safe to ignore
      logger.warn('[cross-post/local] linkedin_accounts lookup failed (table may not exist)', {
        userId: normalizedUserId,
        teamId: normalizedTeamId,
        error: error?.message || String(error),
      });
    }
  }

  return [];
};

/* ───────────────── upstream resolvers with local fallback ───────────────── */

const resolveXStatus = async ({ userId, teamId }) => {
  const tweetGenieUrl = String(process.env.TWEET_GENIE_URL || '').trim();
  const internalApiKey = String(process.env.INTERNAL_API_KEY || '').trim();

  if (!tweetGenieUrl || !internalApiKey) {
    logger.warn('[cross-post/status] Not configured for upstream X proxy; using local fallback', {
      hasTweetGenieUrl: Boolean(tweetGenieUrl),
      hasInternalApiKey: Boolean(internalApiKey),
    });
    const localAccounts = await listLocalXTargets({ userId, teamId });
    return buildAccountsPayload(localAccounts);
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
      logger.warn('[cross-post/status] Upstream X returned non-OK; falling back to local', {
        userId,
        teamId: teamId || null,
        status: response.status,
        code: body?.code,
      });
      const localAccounts = await listLocalXTargets({ userId, teamId });
      return localAccounts.length > 0
        ? buildAccountsPayload(localAccounts)
        : {
            connected: false,
            reason: mapUpstreamFailureReason(response.status, body?.code),
            account: null,
            accounts: [],
          };
    }

    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    if (accounts.length > 0) {
      return buildAccountsPayload(accounts);
    }

    // Upstream returned OK but empty — try local fallback
    const localAccounts = await listLocalXTargets({ userId, teamId });
    return buildAccountsPayload(localAccounts);
  } catch (error) {
    if (error?.name === 'AbortError') {
      logger.warn('[cross-post/status] Upstream X timed out; falling back to local', {
        userId,
        teamId: teamId || null,
      });
    } else {
      logger.warn('[cross-post/status] Failed to fetch X status; falling back to local', {
        userId,
        teamId: teamId || null,
        error: error?.message || String(error),
      });
    }

    const localAccounts = await listLocalXTargets({ userId, teamId });
    return localAccounts.length > 0
      ? buildAccountsPayload(localAccounts)
      : {
          connected: false,
          reason: error?.name === 'AbortError' ? 'timeout' : 'service_unreachable',
          account: null,
          accounts: [],
        };
  }
};

const resolveLinkedInStatus = async ({ userId, teamId }) => {
  const linkedInGenieUrl = String(process.env.LINKEDIN_GENIE_URL || '').trim();
  const internalApiKey = String(process.env.INTERNAL_API_KEY || '').trim();

  if (!linkedInGenieUrl || !internalApiKey) {
    logger.warn('[cross-post/status] Not configured for upstream LinkedIn proxy; using local fallback', {
      hasLinkedInGenieUrl: Boolean(linkedInGenieUrl),
      hasInternalApiKey: Boolean(internalApiKey),
    });
    const localAccounts = await listLocalLinkedInTargets({ userId, teamId });
    return buildAccountsPayload(localAccounts);
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
      logger.warn('[cross-post/status] Upstream LinkedIn returned non-OK; falling back to local', {
        userId,
        teamId: teamId || null,
        status: response.status,
        code: body?.code,
      });
      const localAccounts = await listLocalLinkedInTargets({ userId, teamId });
      return localAccounts.length > 0
        ? buildAccountsPayload(localAccounts)
        : {
            connected: false,
            reason: mapUpstreamFailureReason(response.status, body?.code),
            account: null,
            accounts: [],
          };
    }

    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    if (accounts.length > 0) {
      return buildAccountsPayload(accounts);
    }

    const localAccounts = await listLocalLinkedInTargets({ userId, teamId });
    return buildAccountsPayload(localAccounts);
  } catch (error) {
    if (error?.name === 'AbortError') {
      logger.warn('[cross-post/status] Upstream LinkedIn timed out; falling back to local', {
        userId,
        teamId: teamId || null,
      });
    } else {
      logger.warn('[cross-post/status] Failed to fetch LinkedIn status; falling back to local', {
        userId,
        teamId: teamId || null,
        error: error?.message || String(error),
      });
    }

    const localAccounts = await listLocalLinkedInTargets({ userId, teamId });
    return localAccounts.length > 0
      ? buildAccountsPayload(localAccounts)
      : {
          connected: false,
          reason: error?.name === 'AbortError' ? 'timeout' : 'service_unreachable',
          account: null,
          accounts: [],
        };
  }
};

/* ───────────────── route ───────────────── */

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
