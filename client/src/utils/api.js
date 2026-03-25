import axios from 'axios';
import { buildPlatformLoginUrl } from './platformUrl';

const API_BASE_URL = String(import.meta.env.VITE_API_URL || '').trim();
const AUTH_REDIRECT_STORAGE_KEY = 'meta_genie_auth_redirect_time';
const REDIRECT_COOLDOWN_MS = 2000;
const NON_REFRESHABLE_AUTH_PATHS = ['/auth/refresh', '/auth/logout', '/auth/callback'];
const TEAM_CONTEXT_STORAGE_KEY = 'activeTeamContext';
const AGENCY_WORKSPACE_STORAGE_KEY = 'suitegenie:agency-workspace-context';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

let isRefreshing = false;
let failedQueue = [];

const getPathname = (url = '') => {
  const raw = String(url || '');
  if (!raw) return '';

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      return new URL(raw).pathname;
    } catch {
      return raw.split('?')[0];
    }
  }

  return raw.split('?')[0];
};

const isNonRefreshableAuthPath = (path) =>
  NON_REFRESHABLE_AUTH_PATHS.some((prefix) => path.startsWith(prefix));

const parseStoredJSON = (key) => {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readAgencyWorkspaceContext = () => {
  if (typeof window === 'undefined') return null;

  try {
    const params = new URLSearchParams(window.location.search || '');
    const token = String(params.get('agency_token') || '').trim();
    const workspaceId = String(params.get('workspace_id') || '').trim();
    const tool = String(params.get('tool') || '').trim();
    const target = String(params.get('target') || '').trim();

    if (token && workspaceId) {
      const context = { token, workspaceId, tool: tool || null, target: target || null };
      window.sessionStorage?.setItem(AGENCY_WORKSPACE_STORAGE_KEY, JSON.stringify(context));
      return context;
    }
  } catch {
    // Ignore URL parsing failures and fall back to stored context.
  }

  try {
    const stored = window.sessionStorage?.getItem(AGENCY_WORKSPACE_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
};

const redirectToPlatformLogin = () => {
  if (typeof window === 'undefined') return;

  const currentPath = window.location.pathname || '';
  if (currentPath.includes('/auth/callback')) {
    return;
  }

  const now = Date.now();
  const lastRedirect = Number(sessionStorage.getItem(AUTH_REDIRECT_STORAGE_KEY) || '0');
  if (lastRedirect && now - lastRedirect < REDIRECT_COOLDOWN_MS) {
    return;
  }

  sessionStorage.setItem(AUTH_REDIRECT_STORAGE_KEY, String(now));
  window.location.href = buildPlatformLoginUrl(window.location.href);
};

const processQueue = (error) => {
  failedQueue.forEach((promise) => {
    if (error) {
      promise.reject(error);
    } else {
      promise.resolve();
    }
  });
  failedQueue = [];
};

api.interceptors.request.use((config) => {
  const teamContext = parseStoredJSON(TEAM_CONTEXT_STORAGE_KEY);
  const teamId = teamContext?.team_id || teamContext?.teamId || null;
  const agencyWorkspace = readAgencyWorkspaceContext();

  delete config.headers['x-team-id'];
  delete config.headers['x-agency-token'];
  delete config.headers['x-agency-workspace-id'];
  delete config.headers['x-agency-tool'];
  delete config.headers['x-agency-target'];
  if (teamId) {
    config.headers['x-team-id'] = teamId;
  }
  if (agencyWorkspace?.token && agencyWorkspace?.workspaceId) {
    config.headers['x-agency-token'] = agencyWorkspace.token;
    config.headers['x-agency-workspace-id'] = agencyWorkspace.workspaceId;
    if (agencyWorkspace.tool) {
      config.headers['x-agency-tool'] = agencyWorkspace.tool;
    }
    if (agencyWorkspace.target) {
      config.headers['x-agency-target'] = agencyWorkspace.target;
    }
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config || {};
    const status = error.response?.status;
    const requestPath = getPathname(originalRequest.url);

    if (status === 401 && requestPath.startsWith('/auth/refresh')) {
      redirectToPlatformLogin();
      return Promise.reject(error);
    }

    if (
      status === 401 &&
      !originalRequest._retry &&
      !originalRequest.__skipAuthRefresh &&
      !isNonRefreshableAuthPath(requestPath)
    ) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(() => api(originalRequest));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        await api.post('/auth/refresh', {}, { __skipAuthRefresh: true });
        isRefreshing = false;
        processQueue(null);
        return api(originalRequest);
      } catch (refreshError) {
        isRefreshing = false;
        processQueue(refreshError);
        redirectToPlatformLogin();
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export const authApi = {
  validate: () => api.get('/auth/validate'),
  refresh: () => api.post('/auth/refresh'),
  logout: () => api.post('/auth/logout'),
};

export const dashboardApi = {
  get: () => api.get('/api/dashboard'),
};

export const accountsApi = {
  list: () => api.get('/api/accounts'),
  permissions: () => api.get('/api/accounts/permissions'),
  connectInstagramByok: (payload) => api.post('/api/accounts/instagram/byok-connect', payload),
  disconnect: (id) => api.delete(`/api/accounts/${id}`),
};

export const postsApi = {
  create: (payload) => api.post('/api/posts', payload),
  recent: (limit = 10) => api.get('/api/posts/recent', { params: { limit } }),
  history: (params = {}) => api.get('/api/posts/history', { params }),
  delete: (postId) => api.delete(`/api/posts/${postId}`),
};

export const scheduleApi = {
  list: (params = {}) => api.get('/api/schedule', { params }),
  reschedule: (postId, payload) => api.patch(`/api/schedule/${postId}/reschedule`, payload),
  retry: (postId, payload = {}) => api.post(`/api/schedule/${postId}/retry`, payload),
  cancel: (postId) => api.delete(`/api/schedule/${postId}`),
};

export const analyticsApi = {
  overview: (days = 30) => api.get('/api/analytics/overview', { params: { days } }),
};

export const creditsApi = {
  balance: () => api.get('/api/credits/balance'),
  history: (params) => api.get('/api/credits/history', { params }),
  pricing: () => api.get('/api/credits/pricing'),
  refund: (payload) => api.post('/api/credits/refund', payload),
};

export const crossPostApi = {
  status: () => api.get('/api/cross-post/status'),
};

export const aiApi = {
  generateCaption: (payload) => api.post('/api/ai/caption', payload),
};

export const mediaApi = {
  upload: (formData) =>
    api.post('/api/media/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    }),
};

export const oauthApi = {
  connectUrl: (platform, returnUrl, teamId = null) => {
    const base = `${API_BASE_URL}/api/oauth/${platform}/connect?returnUrl=${encodeURIComponent(returnUrl)}`;
    return teamId ? `${base}&teamId=${encodeURIComponent(teamId)}` : base;
  },
};

export default api;
