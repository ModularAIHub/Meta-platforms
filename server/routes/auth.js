import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { requirePlatformLogin } from '../middleware/requirePlatformLogin.js';
import { clearAuthCookies, setAuthCookies } from '../utils/cookieUtils.js';

const router = express.Router();

const PLATFORM_API_BASE = process.env.NEW_PLATFORM_API_URL || 'http://localhost:3000/api';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PLATFORM_URL = process.env.PLATFORM_URL || (IS_PRODUCTION ? 'https://suitegenie.in' : 'http://localhost:5173');
const CLIENT_URL = process.env.CLIENT_URL || (IS_PRODUCTION ? 'https://social.suitegenie.in' : 'http://localhost:5176');

const isAbsoluteUrl = (value = '') => /^https?:\/\//i.test(String(value));

const isAllowedRedirectOrigin = (value) => {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return true;
    }

    return parsed.hostname === 'suitegenie.in' || parsed.hostname.endsWith('.suitegenie.in');
  } catch {
    return false;
  }
};

const resolveRedirectTarget = (redirect) => {
  const raw = String(redirect || '').trim();
  if (!raw) {
    return `${CLIENT_URL}/dashboard`;
  }

  if (isAbsoluteUrl(raw)) {
    return isAllowedRedirectOrigin(raw) ? raw : `${CLIENT_URL}/dashboard`;
  }

  const normalizedPath = raw.startsWith('/') ? raw : `/${raw}`;
  return `${CLIENT_URL}${normalizedPath}`;
};

router.get('/callback', async (req, res) => {
  try {
    const { token, refreshToken, session, redirect } = req.query;

    let accessToken = token;
    let refresh = refreshToken;

    if (session) {
      const decoded = jwt.verify(session, process.env.JWT_SECRET);
      if (decoded?.type === 'session') {
        accessToken = decoded.accessToken;
        refresh = decoded.refreshToken;
      }
    }

    if (!accessToken) {
      return res.redirect(`${PLATFORM_URL}/login`);
    }

    setAuthCookies(res, accessToken, refresh || null);

    const target = resolveRedirectTarget(redirect);
    return res.redirect(target);
  } catch {
    return res.redirect(`${PLATFORM_URL}/login?error=callback_failed`);
  }
});

router.get('/validate', requirePlatformLogin, (req, res) => {
  return res.json({
    success: true,
    user: req.user,
  });
});

router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    const response = await axios.post(
      `${PLATFORM_API_BASE}/auth/refresh`,
      {},
      {
        headers: {
          Cookie: `refreshToken=${refreshToken}`,
        },
        withCredentials: true,
        timeout: 10000,
        validateStatus: (status) => status < 500,
      }
    );

    if (response.status !== 200) {
      return res.status(401).json({ error: 'Refresh failed' });
    }

    const setCookieHeader = response.headers['set-cookie'] || [];
    const accessCookie = setCookieHeader.find((cookie) => cookie.startsWith('accessToken='));
    const refreshCookie = setCookieHeader.find((cookie) => cookie.startsWith('refreshToken='));

    if (!accessCookie) {
      return res.status(401).json({ error: 'Refresh failed' });
    }

    const newAccess = accessCookie.split('accessToken=')[1].split(';')[0];
    const newRefresh = refreshCookie ? refreshCookie.split('refreshToken=')[1].split(';')[0] : null;

    setAuthCookies(res, newAccess, newRefresh);

    return res.json({ success: true });
  } catch (error) {
    return res.status(401).json({ error: 'Refresh failed', details: error.message });
  }
});

router.post('/logout', (_req, res) => {
  clearAuthCookies(res);
  return res.json({ success: true });
});

export default router;