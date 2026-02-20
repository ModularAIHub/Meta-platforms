import jwt from 'jsonwebtoken';
import axios from 'axios';
import { query } from '../config/database.js';

const NEW_PLATFORM_API_URL = process.env.NEW_PLATFORM_API_URL || 'http://localhost:3000/api';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PLATFORM_URL = process.env.PLATFORM_URL || (IS_PRODUCTION ? 'https://suitegenie.in' : 'http://localhost:5173');
const CLIENT_URL = process.env.CLIENT_URL || (IS_PRODUCTION ? 'https://social.suitegenie.in' : 'http://localhost:5176');

const isApiRequest = (req) => {
  const accept = req.headers.accept || '';
  return (
    accept.includes('application/json') ||
    req.originalUrl.startsWith('/api/') ||
    req.originalUrl.startsWith('/auth/')
  );
};

const redirectToPlatformLogin = (req, res) => {
  const currentUrl = `${CLIENT_URL}${req.originalUrl}`;
  const loginUrl = `${PLATFORM_URL}/login?redirect=${encodeURIComponent(currentUrl)}`;
  return res.redirect(loginUrl);
};

const parseMemberships = (payload) => {
  const memberships = Array.isArray(payload?.teamMemberships) ? payload.teamMemberships : [];
  if (memberships.length > 0) {
    return memberships
      .filter((item) => item?.teamId || item?.team_id)
      .map((item) => ({
        teamId: item.teamId || item.team_id,
        role: item.role || 'viewer',
        status: item.status || 'active',
      }));
  }
  if (payload?.teamId || payload?.team_id) {
    return [
      {
        teamId: payload.teamId || payload.team_id,
        role: payload.role || 'viewer',
        status: 'active',
      },
    ];
  }
  return [];
};

const hydrateTeamFromDatabase = async (userId) => {
  let result;
  try {
    result = await query(
      `SELECT team_id, role
       FROM team_members
       WHERE user_id = $1 AND status = 'active'
       ORDER BY invited_at ASC
       LIMIT 1`,
      [userId]
    );
  } catch {
    return { teamId: null, role: 'viewer' };
  }

  if (!result.rows[0]) {
    return { teamId: null, role: 'viewer' };
  }

  return {
    teamId: result.rows[0].team_id,
    role: result.rows[0].role || 'viewer',
  };
};

export const requirePlatformLogin = async (req, res, next) => {
  try {
    let token = req.cookies?.accessToken;

    if (!token) {
      const authHeader = req.headers.authorization || '';
      token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    }

    if (!token && req.cookies?.refreshToken) {
      try {
        const refreshResponse = await axios.post(
          `${NEW_PLATFORM_API_URL}/auth/refresh`,
          {},
          {
            headers: {
              Cookie: `refreshToken=${req.cookies.refreshToken}`,
            },
            withCredentials: true,
            timeout: 10000,
          }
        );

        const setCookie = refreshResponse.headers['set-cookie'] || [];
        const accessCookie = setCookie.find((entry) => entry.startsWith('accessToken='));

        if (accessCookie) {
          token = accessCookie.split('accessToken=')[1].split(';')[0];
          res.cookie('accessToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: 15 * 60 * 1000,
            ...(process.env.NODE_ENV === 'production' && process.env.COOKIE_DOMAIN
              ? { domain: process.env.COOKIE_DOMAIN }
              : {}),
          });
        }
      } catch {
        // Continue and fail below if token still missing.
      }
    }

    if (!token) {
      if (isApiRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized: no token' });
      }
      return redirectToPlatformLogin(req, res);
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      if (isApiRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized: invalid token' });
      }
      return redirectToPlatformLogin(req, res);
    }

    let platformUserPayload = {};
    try {
      const meResponse = await axios.get(`${NEW_PLATFORM_API_URL}/auth/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 10000,
      });
      platformUserPayload = meResponse.data || {};
    } catch {
      platformUserPayload = {};
    }

    const memberships = parseMemberships(platformUserPayload);
    let primaryTeam = memberships.find((membership) => membership.status === 'active') || null;

    if (!primaryTeam) {
      primaryTeam = await hydrateTeamFromDatabase(decoded.userId);
    }

    req.platformAccessToken = token;
    req.user = {
      id: decoded.userId,
      email: decoded.email,
      ...platformUserPayload,
      teamId: primaryTeam?.teamId || null,
      role: primaryTeam?.role || 'viewer',
      teamMemberships: memberships,
    };

    return next();
  } catch (error) {
    if (isApiRequest(req)) {
      return res.status(401).json({ error: 'Unauthorized', details: error.message });
    }
    return redirectToPlatformLogin(req, res);
  }
};
