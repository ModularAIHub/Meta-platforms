import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';

const INSTAGRAM_API_VERSION = process.env.INSTAGRAM_API_VERSION || 'v23.0';

const createHttpError = (status, message, code = null) => {
  const error = new Error(message);
  error.status = status;
  if (code) {
    error.code = code;
  }
  return error;
};

const getScope = (req) => {
  const userId = req.user.id;
  const { teamId, isTeamMember } = req.teamContext || {};

  return {
    userId,
    teamId: isTeamMember ? teamId : null,
    isTeamMember: Boolean(isTeamMember),
  };
};

const upsertConnectedAccount = async ({
  userId,
  teamId = null,
  platform,
  accountId,
  accountUsername,
  accountDisplayName,
  accessToken,
  refreshToken = null,
  tokenExpiresAt = null,
  profileImageUrl = null,
  followersCount = 0,
  metadata = {},
}) => {
  const lookup = teamId
    ? await query(
        `SELECT id
         FROM social_connected_accounts
         WHERE team_id = $1 AND platform = $2 AND account_id = $3
         LIMIT 1`,
        [teamId, platform, accountId]
      )
    : await query(
        `SELECT id
         FROM social_connected_accounts
         WHERE user_id = $1 AND team_id IS NULL AND platform = $2 AND account_id = $3
         LIMIT 1`,
        [userId, platform, accountId]
      );

  if (lookup.rows[0]) {
    const id = lookup.rows[0].id;
    await query(
      `UPDATE social_connected_accounts
       SET account_username = $1,
           account_display_name = $2,
           access_token = $3,
           refresh_token = $4,
           token_expires_at = $5,
           profile_image_url = $6,
           followers_count = $7,
           metadata = $8::jsonb,
           is_active = true,
           updated_at = NOW()
       WHERE id = $9`,
      [
        accountUsername,
        accountDisplayName,
        accessToken,
        refreshToken,
        tokenExpiresAt,
        profileImageUrl,
        followersCount,
        JSON.stringify(metadata || {}),
        id,
      ]
    );
    return id;
  }

  const id = uuidv4();
  await query(
    `INSERT INTO social_connected_accounts (
      id, user_id, team_id, platform, account_id, account_username, account_display_name,
      access_token, refresh_token, token_expires_at, profile_image_url, followers_count,
      metadata, connected_by, is_active
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12,
      $13::jsonb, $14, true
    )`,
    [
      id,
      userId,
      teamId,
      platform,
      accountId,
      accountUsername,
      accountDisplayName,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      profileImageUrl,
      followersCount,
      JSON.stringify(metadata || {}),
      userId,
    ]
  );

  return id;
};

const exchangeForLongLivedInstagramToken = async (incomingToken) => {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;

  if (!appId || !appSecret) {
    return {
      accessToken: incomingToken,
      tokenExpiresAt: null,
      exchangeApplied: false,
    };
  }

  try {
    const response = await axios.get(`https://graph.facebook.com/${INSTAGRAM_API_VERSION}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: incomingToken,
      },
      timeout: 15000,
    });

    const longLivedToken = response.data?.access_token;
    const expiresIn = Number.parseInt(response.data?.expires_in || '0', 10);
    const tokenExpiresAt =
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null;

    if (!longLivedToken) {
      return {
        accessToken: incomingToken,
        tokenExpiresAt: null,
        exchangeApplied: false,
      };
    }

    return {
      accessToken: longLivedToken,
      tokenExpiresAt,
      exchangeApplied: true,
    };
  } catch {
    return {
      accessToken: incomingToken,
      tokenExpiresAt: null,
      exchangeApplied: false,
    };
  }
};

const fetchInstagramProfile = async ({ accessToken, instagramAccountId }) => {
  const endpoint = `https://graph.facebook.com/${INSTAGRAM_API_VERSION}/${instagramAccountId}`;

  try {
    const response = await axios.get(endpoint, {
      params: {
        access_token: accessToken,
        fields: 'id,name,username,profile_picture_url,followers_count',
      },
      timeout: 15000,
    });

    return response.data;
  } catch {
    const fallback = await axios.get(endpoint, {
      params: {
        access_token: accessToken,
        fields: 'id,username',
      },
      timeout: 15000,
    });

    return fallback.data;
  }
};

const resolvePageMapping = async ({ accessToken, instagramAccountId, facebookPageId }) => {
  try {
    const response = await axios.get(`https://graph.facebook.com/${INSTAGRAM_API_VERSION}/me/accounts`, {
      params: {
        access_token: accessToken,
        fields: 'id,name,instagram_business_account{id,username}',
      },
      timeout: 15000,
    });

    const pages = Array.isArray(response.data?.data) ? response.data.data : [];
    const matchByInstagram = pages.find(
      (page) => String(page.instagram_business_account?.id || '') === String(instagramAccountId)
    );

    if (facebookPageId) {
      const explicitPage = pages.find((page) => String(page.id) === String(facebookPageId));

      if (!explicitPage) {
        throw createHttpError(
          400,
          'Provided Facebook Page ID is not available for this token. Ensure pages_show_list is granted.',
          'INVALID_FACEBOOK_PAGE_ID'
        );
      }

      if (String(explicitPage.instagram_business_account?.id || '') !== String(instagramAccountId)) {
        throw createHttpError(
          400,
          'Provided Facebook Page ID is not linked to this Instagram business account.',
          'PAGE_IG_MISMATCH'
        );
      }

      return {
        pageId: explicitPage.id,
        pageName: explicitPage.name || null,
      };
    }

    if (matchByInstagram) {
      return {
        pageId: matchByInstagram.id,
        pageName: matchByInstagram.name || null,
      };
    }
  } catch (error) {
    if (error.status) {
      throw error;
    }
    // Page mapping is optional if the account profile itself verifies.
  }

  return {
    pageId: facebookPageId || null,
    pageName: null,
  };
};

export const listAccounts = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = getScope(req);

    const result = isTeamMember && teamId
      ? await query(
          `SELECT id, platform, account_id, account_username, account_display_name, profile_image_url,
                  followers_count, metadata, token_expires_at, is_active, created_at, updated_at
           FROM social_connected_accounts
           WHERE team_id = $1 AND is_active = true
           ORDER BY created_at DESC`,
          [teamId]
        )
      : await query(
          `SELECT id, platform, account_id, account_username, account_display_name, profile_image_url,
                  followers_count, metadata, token_expires_at, is_active, created_at, updated_at
           FROM social_connected_accounts
           WHERE user_id = $1 AND team_id IS NULL AND is_active = true
           ORDER BY created_at DESC`,
          [userId]
        );

    return res.json({ success: true, accounts: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch connected accounts', details: error.message });
  }
};

export const getAccountPermissions = async (req, res) => {
  const { teamId, role, isTeamMember } = req.teamContext || {};
  const canManageConnections = !isTeamMember || !teamId || ['owner', 'admin'].includes(role);

  return res.json({
    role: role || 'viewer',
    teamId: teamId || null,
    isTeamMember: Boolean(isTeamMember),
    canManageConnections,
  });
};

export const disconnectAccount = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = getScope(req);
    const { accountId } = req.params;

    const lookup = isTeamMember && teamId
      ? await query(
          `SELECT id
           FROM social_connected_accounts
           WHERE id = $1 AND team_id = $2 AND is_active = true
           LIMIT 1`,
          [accountId, teamId]
        )
      : await query(
          `SELECT id
           FROM social_connected_accounts
           WHERE id = $1 AND user_id = $2 AND team_id IS NULL AND is_active = true
           LIMIT 1`,
          [accountId, userId]
        );

    if (!lookup.rows[0]) {
      return res.status(404).json({ error: 'Account not found' });
    }

    await query(
      `UPDATE social_connected_accounts
       SET is_active = false, updated_at = NOW()
       WHERE id = $1`,
      [accountId]
    );

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to disconnect account', details: error.message });
  }
};

export const connectInstagramByok = async (req, res) => {
  try {
    const { userId, teamId } = getScope(req);
    const accessTokenRaw = String(req.body?.access_token || '').trim();
    const instagramAccountIdRaw = String(req.body?.instagram_account_id || '').trim();
    const facebookPageIdRaw = String(req.body?.facebook_page_id || '').trim();

    if (!accessTokenRaw) {
      throw createHttpError(400, 'Instagram access token is required', 'ACCESS_TOKEN_REQUIRED');
    }

    if (!instagramAccountIdRaw) {
      throw createHttpError(400, 'Instagram account ID is required', 'INSTAGRAM_ACCOUNT_ID_REQUIRED');
    }

    const tokenData = await exchangeForLongLivedInstagramToken(accessTokenRaw);

    let profile;
    try {
      profile = await fetchInstagramProfile({
        accessToken: tokenData.accessToken,
        instagramAccountId: instagramAccountIdRaw,
      });
    } catch {
      throw createHttpError(
        400,
        'Unable to verify Instagram account with this token. Check token, permissions, and account ID.',
        'INSTAGRAM_VERIFY_FAILED'
      );
    }

    if (!profile?.id) {
      throw createHttpError(
        400,
        'Instagram account verification returned no account ID',
        'INSTAGRAM_PROFILE_INVALID'
      );
    }

    const pageData = await resolvePageMapping({
      accessToken: tokenData.accessToken,
      instagramAccountId: profile.id,
      facebookPageId: facebookPageIdRaw || null,
    });

    await upsertConnectedAccount({
      userId,
      teamId,
      platform: 'instagram',
      accountId: String(profile.id),
      accountUsername: profile.username || `instagram_${profile.id}`,
      accountDisplayName: profile.name || profile.username || 'Instagram Account',
      accessToken: tokenData.accessToken,
      refreshToken: null,
      tokenExpiresAt: tokenData.tokenExpiresAt,
      profileImageUrl: profile.profile_picture_url || null,
      followersCount: Number.parseInt(profile.followers_count || '0', 10) || 0,
      metadata: {
        connectionType: 'byok_token',
        exchangeApplied: tokenData.exchangeApplied,
        pageId: pageData.pageId || null,
        pageName: pageData.pageName || null,
      },
    });

    const expiresInDays = tokenData.tokenExpiresAt
      ? Math.max(0, Math.floor((new Date(tokenData.tokenExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : null;

    return res.json({
      success: true,
      account: {
        id: String(profile.id),
        username: profile.username || null,
        name: profile.name || profile.username || 'Instagram Account',
        profile_picture_url: profile.profile_picture_url || null,
        followers_count: Number.parseInt(profile.followers_count || '0', 10) || 0,
      },
      token: {
        exchangeApplied: tokenData.exchangeApplied,
        expiresAt: tokenData.tokenExpiresAt,
        expiresInDays,
      },
    });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    return res.status(status).json({
      error: status === 500 ? 'Failed to connect Instagram account' : error.message,
      code: error.code || null,
      details: status === 500 ? error.message : undefined,
    });
  }
};
