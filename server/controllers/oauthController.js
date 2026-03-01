import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { createOAuthState, consumeOAuthState } from '../services/oauthStateStore.js';

const isMockOAuthEnabled = () => String(process.env.SOCIAL_MOCK_OAUTH || 'false').toLowerCase() === 'true';
const THREADS_OAUTH_AUTHORIZE_URL =
  process.env.THREADS_OAUTH_AUTHORIZE_URL || 'https://threads.net/oauth/authorize';

const getFirstEnvValue = (...keys) => {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const getThreadsAppId = () => getFirstEnvValue('THREADS_APP_ID', 'THREADS_CLIENT_ID', 'INSTAGRAM_APP_ID');
const getThreadsAppSecret = () =>
  getFirstEnvValue('THREADS_APP_SECRET', 'THREADS_CLIENT_SECRET', 'INSTAGRAM_APP_SECRET');
const getThreadsRedirectUri = () => getFirstEnvValue('THREADS_REDIRECT_URI');
const isThreadsTesterPermissionError = (error) => {
  const payload = error?.response?.data?.error || {};
  const message = String(payload.message || '').toLowerCase();
  return payload.error_subcode === 10 || message.includes('threads_basic permission');
};

const isInstagramTesterPermissionError = (error) => {
  const payload = error?.response?.data?.error || {};
  const message = String(payload.message || '').toLowerCase();
  // Matches Instagram's "Application does not have permission for this action" or subcode 10 errors
  return payload.error_subcode === 10 || message.includes('permission for this action') || message.includes('instagram_business_basic permission');
};

const ensureReturnUrl = (value) => {
  if (!value) {
    // CLIENT_URL must be set to the frontend origin in production (e.g. https://meta.suitegenie.in).
    // VERCEL_URL is the server's own hostname — not the client — so it's not used here.
    const clientBase = (process.env.CLIENT_URL || '').trim();
    return `${clientBase || 'http://localhost:5176'}/accounts`;
  }
  return value;
};

const appendQuery = (url, key, value) => {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
};

const redirectWithError = (res, returnUrl, errorCode) => {
  const fallback = ensureReturnUrl(returnUrl);
  return res.redirect(appendQuery(fallback, 'error', errorCode));
};

const redirectWithSuccess = (res, returnUrl, platform) => {
  const fallback = ensureReturnUrl(returnUrl);
  return res.redirect(appendQuery(fallback, 'connected', platform));
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

export const connectInstagram = async (req, res) => {
  const returnUrl = ensureReturnUrl(req.query.returnUrl);
  const teamId = req.teamContext?.teamId || null;

  const state = await createOAuthState({
    platform: 'instagram',
    userId: req.user.id,
    teamId,
    returnUrl,
  });

  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  if (!appId || !appSecret || !redirectUri || isMockOAuthEnabled()) {
    return res.redirect(`/api/oauth/instagram/callback?state=${encodeURIComponent(state)}&mock=1`);
  }

  const version = process.env.INSTAGRAM_API_VERSION || 'v23.0';
  const scopesRaw = process.env.INSTAGRAM_SCOPES || 'instagram_business_basic,instagram_business_content_publish,pages_show_list,business_management';

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: scopesRaw,
  });

  const authUrl = `https://www.facebook.com/${version}/dialog/oauth?${params.toString()}`;
  return res.redirect(authUrl);
};

export const instagramCallback = async (req, res) => {
  const { state, code, error, mock } = req.query;

  const statePayload = state ? await consumeOAuthState(state) : null;
  if (!statePayload) {
    return redirectWithError(res, ensureReturnUrl(null), 'invalid_state');
  }

  const { userId, teamId, returnUrl } = statePayload;

  if (error) {
    return redirectWithError(res, returnUrl, 'instagram_oauth_denied');
  }

  try {
    if (mock === '1' || isMockOAuthEnabled()) {
      await upsertConnectedAccount({
        userId,
        teamId,
        platform: 'instagram',
        accountId: `ig_mock_${userId}`,
        accountUsername: `ig_${String(userId).slice(0, 8)}`,
        accountDisplayName: 'Instagram Mock Account',
        accessToken: `mock_instagram_token_${Date.now()}`,
        refreshToken: null,
        tokenExpiresAt: null,
        profileImageUrl: null,
        followersCount: 1200,
        metadata: { mock: true },
      });

      return redirectWithSuccess(res, returnUrl, 'instagram');
    }

    const version = process.env.INSTAGRAM_API_VERSION || 'v23.0';
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    const tokenResponse = await axios.get(`https://graph.facebook.com/${version}/oauth/access_token`, {
      params: {
        client_id: process.env.INSTAGRAM_APP_ID,
        client_secret: process.env.INSTAGRAM_APP_SECRET,
        redirect_uri: redirectUri,
        code,
      },
      timeout: 15000,
    });

    const accessToken = tokenResponse.data?.access_token;
    const expiresIn = Number.parseInt(tokenResponse.data?.expires_in || '0', 10);
    const tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    if (!accessToken) {
      return redirectWithError(res, returnUrl, 'instagram_token_failed');
    }

    let accountId = null;
    let accountUsername = null;
    let accountDisplayName = null;
    let profileImageUrl = null;
    let followersCount = 0;
    let metadata = {};

    try {
      const pagesResponse = await axios.get(`https://graph.facebook.com/${version}/me/accounts`, {
        params: {
          fields: 'id,name,instagram_business_account{id,username,profile_picture_url,followers_count}',
          access_token: accessToken,
        },
        timeout: 15000,
      });

      const pageWithInstagram = (pagesResponse.data?.data || []).find(
        (page) => page.instagram_business_account && page.instagram_business_account.id
      );

      if (pageWithInstagram) {
        const ig = pageWithInstagram.instagram_business_account;
        accountId = String(ig.id);
        accountUsername = ig.username || pageWithInstagram.name || `instagram_${ig.id}`;
        accountDisplayName = ig.username || pageWithInstagram.name || 'Instagram Account';
        profileImageUrl = ig.profile_picture_url || null;
        followersCount = Number.parseInt(ig.followers_count || '0', 10) || 0;
        metadata = {
          pageId: pageWithInstagram.id,
          pageName: pageWithInstagram.name,
        };
      }
    } catch {
      // Fall back to basic profile lookup.
    }

    if (!accountId) {
      const profileResponse = await axios.get(`https://graph.facebook.com/${version}/me`, {
        params: {
          fields: 'id,name',
          access_token: accessToken,
        },
        timeout: 15000,
      });

      accountId = String(profileResponse.data?.id || `ig_user_${userId}`);
      accountUsername = profileResponse.data?.name?.replace(/\s+/g, '').toLowerCase() || `instagram_${accountId}`;
      accountDisplayName = profileResponse.data?.name || 'Instagram Account';
      metadata = {
        profileType: 'facebook_user_fallback',
      };
    }

    await upsertConnectedAccount({
      userId,
      teamId,
      platform: 'instagram',
      accountId,
      accountUsername,
      accountDisplayName,
      accessToken,
      refreshToken: null,
      tokenExpiresAt,
      profileImageUrl,
      followersCount,
      metadata,
    });

    return redirectWithSuccess(res, returnUrl, 'instagram');
  } catch (error) {
    if (isInstagramTesterPermissionError(error)) {
      return redirectWithError(res, returnUrl, 'instagram_tester_or_app_review_required');
    }
    return redirectWithError(res, returnUrl, 'instagram_connection_failed');
  }
};

export const connectThreads = async (req, res) => {
  console.log('[THREADS CONNECT] Started');
  const returnUrl = ensureReturnUrl(req.query.returnUrl);
  const teamId = req.teamContext?.teamId || null;

  console.log('[THREADS CONNECT] User:', { userId: req.user.id, teamId, returnUrl });

  const state = await createOAuthState({
    platform: 'threads',
    userId: req.user.id,
    teamId,
    returnUrl,
  });

  console.log('[THREADS CONNECT] State created:', state.substring(0, 8));

  const appId = getThreadsAppId();
  const appSecret = getThreadsAppSecret();
  const redirectUri = getThreadsRedirectUri();

  console.log('[THREADS CONNECT] Config:', { appId: appId?.substring(0, 8), redirectUri });

  if (isMockOAuthEnabled()) {
    console.log('[THREADS CONNECT] Mock mode enabled, redirecting to callback');
    return res.redirect(`/api/oauth/threads/callback?state=${encodeURIComponent(state)}&mock=1`);
  }

  if (!appId || !appSecret || !redirectUri) {
    console.error('[THREADS CONNECT] Missing OAuth configuration');
    return redirectWithError(res, returnUrl, 'threads_oauth_not_configured');
  }

  const scopesRaw = process.env.THREADS_SCOPES || 'threads_basic,threads_content_publish';
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: scopesRaw,
    response_type: 'code',
    state,
  });

  const authUrl = `${THREADS_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
  console.log('[THREADS CONNECT] Redirecting to Threads OAuth URL:', authUrl);
  return res.redirect(authUrl);
};

export const threadsCallback = async (req, res) => {
  const { state, code, error, mock } = req.query;

  console.log('[THREADS CALLBACK] Started', { state: state?.substring(0, 8), code: code?.substring(0, 8), error, mock });

  const statePayload = state ? await consumeOAuthState(state) : null;
  if (!statePayload) {
    return redirectWithError(res, ensureReturnUrl(null), 'invalid_state');
  }

  const { userId, teamId, returnUrl } = statePayload;
  console.log('[THREADS CALLBACK] State payload:', { userId, teamId, returnUrl });

  if (error) {
    console.error('[THREADS CALLBACK] OAuth error from Threads:', error);
    return redirectWithError(res, returnUrl, 'threads_oauth_denied');
  }

  try {
    if (mock === '1' || isMockOAuthEnabled()) {
      await upsertConnectedAccount({
        userId,
        teamId,
        platform: 'threads',
        accountId: `threads_mock_${userId}`,
        accountUsername: `threads_${String(userId).slice(0, 8)}`,
        accountDisplayName: 'Threads Mock Account',
        accessToken: `mock_threads_token_${Date.now()}`,
        refreshToken: null,
        tokenExpiresAt: null,
        profileImageUrl: null,
        followersCount: 0,
        metadata: { mock: true },
      });

      console.log('[THREADS CALLBACK] Mock connection successful');
      return redirectWithSuccess(res, returnUrl, 'threads');
    }

    if (!code) {
      console.error('[THREADS CALLBACK] No authorization code received');
      return redirectWithError(res, returnUrl, 'threads_code_missing');
    }

    const appId = getThreadsAppId();
    const appSecret = getThreadsAppSecret();
    const redirectUri = getThreadsRedirectUri();

    console.log('[THREADS CALLBACK] Config:', { appId: appId?.substring(0, 8), redirectUri });

    if (!appId || !appSecret || !redirectUri) {
      console.error('[THREADS CALLBACK] Missing OAuth configuration');
      return redirectWithError(res, returnUrl, 'threads_oauth_not_configured');
    }

    console.log('[THREADS CALLBACK] Exchanging code for token...');
    const tokenResponse = await axios.post(
      'https://graph.threads.net/oauth/access_token',
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: String(code),
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      }
    );

    console.log('[THREADS CALLBACK] Token response received:', {
      hasToken: !!tokenResponse.data?.access_token,
      userId: tokenResponse.data?.user_id
    });

    const shortLivedToken = tokenResponse.data?.access_token;
    const tokenUserId = String(tokenResponse.data?.user_id || '');

    if (!shortLivedToken) {
      console.error('[THREADS CALLBACK] No access token in response');
      return redirectWithError(res, returnUrl, 'threads_token_failed');
    }

    let accessToken = shortLivedToken;
    let tokenExpiresAt = null;
    let longLivedApplied = false;

    try {
      console.log('[THREADS CALLBACK] Exchanging for long-lived token...');
      const longLived = await axios.get('https://graph.threads.net/access_token', {
        params: {
          grant_type: 'th_exchange_token',
          client_secret: appSecret,
          access_token: shortLivedToken,
        },
        timeout: 15000,
      });

      if (longLived.data?.access_token) {
        accessToken = longLived.data.access_token;
        longLivedApplied = true;
        console.log('[THREADS CALLBACK] Long-lived token obtained');
      }

      const expiresIn = Number.parseInt(longLived.data?.expires_in || '0', 10);
      if (Number.isFinite(expiresIn) && expiresIn > 0) {
        tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      }
    } catch (longLivedError) {
      console.warn('[THREADS CALLBACK] Long-lived token exchange failed:', longLivedError.message);
      // Continue with short-lived token when long-lived exchange fails.
    }

    let profile = null;
    try {
      console.log('[THREADS CALLBACK] Fetching profile...');
      const meResponse = await axios.get('https://graph.threads.net/v1.0/me', {
        params: {
          fields: 'id,username,name,threads_profile_picture_url',
          access_token: accessToken,
        },
        timeout: 15000,
      });
      profile = meResponse.data || null;
      console.log('[THREADS CALLBACK] Profile fetched:', { id: profile?.id, username: profile?.username });
    } catch (profileError) {
      console.warn('[THREADS CALLBACK] Profile fetch failed, trying with user_id:', profileError.message);
      if (tokenUserId) {
        const userResponse = await axios.get(`https://graph.threads.net/v1.0/${tokenUserId}`, {
          params: {
            fields: 'id,username,name,threads_profile_picture_url',
            access_token: accessToken,
          },
          timeout: 15000,
        });
        profile = userResponse.data || null;
        console.log('[THREADS CALLBACK] Profile fetched via user_id:', { id: profile?.id, username: profile?.username });
      }
    }

    const accountId = String(profile?.id || tokenUserId || `threads_user_${userId}`);
    const accountUsername = profile?.username || `threads_${accountId}`;
    const accountDisplayName = profile?.name || profile?.username || 'Threads Account';

    console.log('[THREADS CALLBACK] Saving account:', { accountId, accountUsername });

    await upsertConnectedAccount({
      userId,
      teamId,
      platform: 'threads',
      accountId,
      accountUsername,
      accountDisplayName,
      accessToken,
      refreshToken: null,
      tokenExpiresAt,
      profileImageUrl: profile?.threads_profile_picture_url || null,
      followersCount: 0,
      metadata: {
        profileFetched: Boolean(profile?.id),
        longLivedApplied,
      },
    });

    console.log('[THREADS CALLBACK] Connection successful, redirecting to:', returnUrl);
    return redirectWithSuccess(res, returnUrl, 'threads');
  } catch (error) {
    console.error('[THREADS CALLBACK] Error:', error.message);
    console.error('[THREADS CALLBACK] Error details:', error.response?.data || error);
    if (isThreadsTesterPermissionError(error)) {
      return redirectWithError(res, returnUrl, 'threads_tester_or_app_review_required');
    }
    return redirectWithError(res, returnUrl, 'threads_connection_failed');
  }
};

export const connectYoutube = async (req, res) => {
  const returnUrl = ensureReturnUrl(req.query.returnUrl);
  const teamId = req.teamContext?.teamId || null;

  const state = await createOAuthState({
    platform: 'youtube',
    userId: req.user.id,
    teamId,
    returnUrl,
  });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri || isMockOAuthEnabled()) {
    return res.redirect(`/api/oauth/youtube/callback?state=${encodeURIComponent(state)}&mock=1`);
  }

  const scopes = (process.env.YOUTUBE_SCOPES || '').trim() || [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
  ].join(' ');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: scopes,
    state,
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return res.redirect(authUrl);
};

export const youtubeCallback = async (req, res) => {
  const { state, code, error, mock } = req.query;

  const statePayload = state ? await consumeOAuthState(state) : null;
  if (!statePayload) {
    return redirectWithError(res, ensureReturnUrl(null), 'invalid_state');
  }

  const { userId, teamId, returnUrl } = statePayload;

  if (error) {
    return redirectWithError(res, returnUrl, 'youtube_oauth_denied');
  }

  try {
    if (mock === '1' || isMockOAuthEnabled()) {
      await upsertConnectedAccount({
        userId,
        teamId,
        platform: 'youtube',
        accountId: `yt_mock_${userId}`,
        accountUsername: `yt_${String(userId).slice(0, 8)}`,
        accountDisplayName: 'YouTube Mock Channel',
        accessToken: `mock_youtube_token_${Date.now()}`,
        refreshToken: `mock_youtube_refresh_${Date.now()}`,
        tokenExpiresAt: null,
        profileImageUrl: null,
        followersCount: 3400,
        metadata: { mock: true },
      });

      return redirectWithSuccess(res, returnUrl, 'youtube');
    }

    const tokenResponse = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      }
    );

    const accessToken = tokenResponse.data?.access_token;
    const refreshToken = tokenResponse.data?.refresh_token || null;
    const expiresIn = Number.parseInt(tokenResponse.data?.expires_in || '0', 10);

    if (!accessToken) {
      return redirectWithError(res, returnUrl, 'youtube_token_failed');
    }

    const tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: {
        part: 'snippet,statistics',
        mine: 'true',
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      timeout: 15000,
    });

    const channel = channelResponse.data?.items?.[0];
    if (!channel?.id) {
      return redirectWithError(res, returnUrl, 'youtube_channel_not_found');
    }

    const accountId = String(channel.id);
    const accountDisplayName = channel.snippet?.title || 'YouTube Channel';
    const accountUsername =
      channel.snippet?.customUrl?.replace(/^@/, '') ||
      accountDisplayName.replace(/\s+/g, '').toLowerCase();
    const profileImageUrl =
      channel.snippet?.thumbnails?.default?.url ||
      channel.snippet?.thumbnails?.medium?.url ||
      null;
    const followersCount = Number.parseInt(channel.statistics?.subscriberCount || '0', 10) || 0;

    await upsertConnectedAccount({
      userId,
      teamId,
      platform: 'youtube',
      accountId,
      accountUsername,
      accountDisplayName,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      profileImageUrl,
      followersCount,
      metadata: {
        channelId: accountId,
        videoCount: Number.parseInt(channel.statistics?.videoCount || '0', 10) || 0,
      },
    });

    return redirectWithSuccess(res, returnUrl, 'youtube');
  } catch {
    return redirectWithError(res, returnUrl, 'youtube_connection_failed');
  }
};
