import jwt from 'jsonwebtoken';
import axios from 'axios';
import { pool } from '../config/database.js';
import { setAuthCookies, clearAuthCookies } from '../utils/cookieUtils.js';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

// Increased from 30s → 5 min default. Override via AUTH_CACHE_TTL_MS in .env
const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS || 300000);

const platformUserCache = new Map();
const linkedinAuthCache = new Map();
const PLATFORM_API_BASE_URL = process.env.NEW_PLATFORM_API_URL || 'http://localhost:3000/api';

const getCacheValue = (cache, key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

const setCacheValue = (cache, key, value) => {
  cache.set(key, {
    value,
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
  });
};

const extractCookieValue = (setCookieHeader, cookieName) => {
  if (!Array.isArray(setCookieHeader)) return null;
  const targetPrefix = `${cookieName}=`;
  const rawCookie = setCookieHeader.find((cookie) => String(cookie).startsWith(targetPrefix));
  if (!rawCookie) return null;
  return rawCookie.slice(targetPrefix.length).split(';')[0] || null;
};

const applyPlatformRefreshedAuthCookies = (res, setCookieHeader) => {
  const newAccessToken = extractCookieValue(setCookieHeader, 'accessToken');
  if (!newAccessToken) return null;
  const newRefreshToken = extractCookieValue(setCookieHeader, 'refreshToken');
  setAuthCookies(res, newAccessToken, newRefreshToken || null);
  return newAccessToken;
};

const buildPlatformRefreshHeaders = (req) => {
  const refreshToken = req.cookies?.refreshToken;
  const csrfToken = req.cookies?._csrf || req.headers['x-csrf-token'];
  const cookieParts = [`refreshToken=${refreshToken}`];
  const headers = {};
  if (csrfToken) {
    cookieParts.push(`_csrf=${csrfToken}`);
    headers['x-csrf-token'] = csrfToken;
  }
  headers.Cookie = cookieParts.join('; ');
  return headers;
};

export async function requirePlatformLogin(req, res, next) {
  if (req.isInternal) {
    return next();
  }

  function isApiRequest(req) {
    const accept = req.headers['accept'] || '';
    const xrw = req.headers['x-requested-with'] || '';
    return (
      accept.includes('application/json') ||
      xrw === 'XMLHttpRequest' ||
      req.originalUrl.startsWith('/api/') ||
      req.originalUrl.startsWith('/auth/')
    );
  }

  try {
    // 1. Get token from cookie or header
    let token = req.cookies?.accessToken;
    if (!token) {
      const authHeader = req.headers['authorization'];
      token = authHeader && authHeader.split(' ')[1];
    }

    // 2. If no token, try refresh
    if (!token && req.cookies?.refreshToken) {
      try {
        const refreshResponse = await axios.post(
          `${PLATFORM_API_BASE_URL}/auth/refresh`,
          {},
          {
            headers: buildPlatformRefreshHeaders(req),
            withCredentials: true,
          }
        );
        if (refreshResponse.status !== 200) {
          clearAuthCookies(res);
          if (isApiRequest(req)) {
            return res.status(401).json({ error: 'Unauthorized: refresh failed' });
          } else {
            const currentUrl = `${process.env.CLIENT_URL || 'http://localhost:5175'}${req.originalUrl}`;
            return res.redirect(
              `${process.env.PLATFORM_URL || 'http://localhost:3000'}/login?redirect=${encodeURIComponent(currentUrl)}`
            );
          }
        }
        const setCookieHeader = refreshResponse.headers['set-cookie'];
        if (setCookieHeader) {
          const newToken = applyPlatformRefreshedAuthCookies(res, setCookieHeader);
          if (newToken) {
            token = newToken;
          } else {
            if (isApiRequest(req)) {
              return res.status(401).json({ error: 'Unauthorized: no access token after refresh' });
            } else {
              const currentUrl = `${process.env.CLIENT_URL || 'http://localhost:5175'}${req.originalUrl}`;
              return res.redirect(
                `${process.env.PLATFORM_URL || 'http://localhost:3000'}/login?redirect=${encodeURIComponent(currentUrl)}`
              );
            }
          }
        }
      } catch {
        clearAuthCookies(res);
        if (isApiRequest(req)) {
          return res.status(401).json({ error: 'Unauthorized: refresh failed' });
        } else {
          const currentUrl = `${process.env.CLIENT_URL || 'http://localhost:5175'}${req.originalUrl}`;
          return res.redirect(
            `${process.env.PLATFORM_URL || 'http://localhost:3000'}/login?redirect=${encodeURIComponent(currentUrl)}`
          );
        }
      }
    }

    // 3. If still no token, return 401
    if (!token) {
      if (isApiRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized: no token' });
      } else {
        const currentUrl = `${process.env.CLIENT_URL || 'http://localhost:5175'}${req.originalUrl}`;
        return res.redirect(
          `${process.env.PLATFORM_URL || 'http://localhost:3000'}/login?redirect=${encodeURIComponent(currentUrl)}`
        );
      }
    }

    // 4. Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError' && req.cookies?.refreshToken) {
        try {
          const refreshResponse = await axios.post(
            `${PLATFORM_API_BASE_URL}/auth/refresh`,
            {},
            {
              headers: buildPlatformRefreshHeaders(req),
              withCredentials: true,
            }
          );
          const setCookieHeader = refreshResponse.headers['set-cookie'];
          if (setCookieHeader) {
            const newToken = applyPlatformRefreshedAuthCookies(res, setCookieHeader);
            if (newToken) {
              decoded = jwt.verify(newToken, process.env.JWT_SECRET);
              token = newToken;
            } else {
              throw new Error('No access token in Platform refresh response');
            }
          }
        } catch {
          clearAuthCookies(res);
          if (isApiRequest(req)) {
            return res.status(401).json({ error: 'Unauthorized: refresh failed' });
          } else {
            const currentUrl = `${process.env.CLIENT_URL || 'http://localhost:5175'}${req.originalUrl}`;
            return res.redirect(
              `${process.env.PLATFORM_URL || 'http://localhost:3000'}/login?redirect=${encodeURIComponent(currentUrl)}`
            );
          }
        }
      } else {
        if (isApiRequest(req)) {
          return res.status(401).json({ error: 'Unauthorized: invalid token' });
        } else {
          const currentUrl = `${process.env.CLIENT_URL || 'http://localhost:5175'}${req.originalUrl}`;
          return res.redirect(
            `${process.env.PLATFORM_URL || 'http://localhost:3000'}/login?redirect=${encodeURIComponent(currentUrl)}`
          );
        }
      }
    }

    // 5. Get user info from platform (with 5-min cache)
    const platformCacheKey = `${decoded.userId}:${decoded.email || ''}`;
    const cachedPlatformUser = getCacheValue(platformUserCache, platformCacheKey);

    if (cachedPlatformUser) {
      req.user = {
        id: decoded.userId,
        email: decoded.email,
        ...cachedPlatformUser,
      };
    } else {
      try {
        const response = await axios.get(
          `${process.env.NEW_PLATFORM_API_URL || 'http://localhost:3000/api'}/auth/me`,
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 8000,
          }
        );
        const userPayload = response.data || {};
        setCacheValue(platformUserCache, platformCacheKey, userPayload);
        req.user = {
          id: decoded.userId,
          email: decoded.email,
          ...userPayload,
        };
      } catch {
        // Fallback to JWT-only user — non-fatal
        req.user = {
          id: decoded.userId,
          email: decoded.email,
        };
      }
    }

    // 6. Attach LinkedIn token (for cross-post status checks) — with 5-min cache
    if (req.user?.id) {
      try {
        const linkedinCacheKey = req.user.id;
        const cachedLinkedinAuth = getCacheValue(linkedinAuthCache, linkedinCacheKey);
        let linkedinAuth = cachedLinkedinAuth;

        if (!linkedinAuth) {
          const { rows } = await pool.query(
            `SELECT access_token, linkedin_user_id FROM linkedin_auth WHERE user_id = $1`,
            [req.user.id]
          );
          linkedinAuth = rows[0] || null;
          setCacheValue(linkedinAuthCache, linkedinCacheKey, linkedinAuth);
        }

        if (linkedinAuth?.access_token && linkedinAuth?.linkedin_user_id) {
          req.user.linkedinAccessToken = linkedinAuth.access_token;
          req.user.linkedinUrn = `urn:li:person:${linkedinAuth.linkedin_user_id}`;
          req.user.linkedinUserId = linkedinAuth.linkedin_user_id;
        }
      } catch (err) {
        console.error('[requirePlatformLogin] Failed to fetch LinkedIn token/URN:', err);
      }
    }

    next();
  } catch (error) {
    if (isApiRequest(req)) {
      return res.status(401).json({ error: 'Unauthorized: exception' });
    } else {
      const currentUrl = `${process.env.CLIENT_URL || 'http://localhost:5175'}${req.originalUrl}`;
      return res.redirect(
        `${process.env.PLATFORM_URL || 'http://localhost:3000'}/login?redirect=${encodeURIComponent(currentUrl)}`
      );
    }
  }
}