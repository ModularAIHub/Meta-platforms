import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { authApi } from '../utils/api';
import { buildPlatformLoginUrl } from '../utils/platformUrl';

const AuthContext = createContext(null);
const AUTH_REDIRECT_STORAGE_KEY = 'social_genie_auth_redirect_time';
const REDIRECT_COOLDOWN_MS = 2000;

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const hasCheckedRef = useRef(false);

  const checkAuthStatus = async () => {
    try {
      const response = await authApi.validate();
      if (response.data?.success) {
        setUser(response.data.user || null);
        setIsAuthenticated(true);
      } else {
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch {
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (hasCheckedRef.current) return;
    hasCheckedRef.current = true;
    checkAuthStatus();
  }, []);

  const redirectToLogin = () => {
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

  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      // Best effort logout.
    }
    setUser(null);
    setIsAuthenticated(false);
    redirectToLogin();
  };

  const value = {
    user,
    isLoading,
    isAuthenticated,
    checkAuthStatus,
    redirectToLogin,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};