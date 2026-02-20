import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { accountsApi } from '../utils/api';
import { useAuth } from './AuthContext';

const AccountContext = createContext(null);

const DEFAULT_PERMISSIONS = {
  role: 'viewer',
  canManageConnections: false,
  teamId: null,
};

export const useAccounts = () => {
  const context = useContext(AccountContext);
  if (!context) {
    throw new Error('useAccounts must be used within AccountProvider');
  }
  return context;
};

export const AccountProvider = ({ children }) => {
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS);
  const [loading, setLoading] = useState(true);

  const fallbackPermissions = useMemo(() => {
    const role = user?.role || 'viewer';
    const teamId = user?.teamId || user?.team_id || null;
    const canManageConnections = !teamId || ['owner', 'admin'].includes(role);

    return {
      role,
      teamId,
      canManageConnections,
    };
  }, [user]);

  const refreshAccounts = useCallback(async () => {
    if (!isAuthenticated) {
      setAccounts([]);
      setPermissions(DEFAULT_PERMISSIONS);
      return;
    }

    const [accountsResult, permissionsResult] = await Promise.allSettled([
      accountsApi.list(),
      accountsApi.permissions(),
    ]);

    if (accountsResult.status === 'fulfilled') {
      setAccounts(accountsResult.value.data?.accounts || []);
    } else {
      setAccounts([]);
    }

    if (permissionsResult.status === 'fulfilled') {
      setPermissions(permissionsResult.value.data || fallbackPermissions);
    } else {
      setPermissions(fallbackPermissions);
    }
  }, [isAuthenticated, fallbackPermissions]);

  useEffect(() => {
    let mounted = true;

    const run = async () => {
      if (authLoading) {
        return;
      }

      if (!isAuthenticated) {
        setAccounts([]);
        setPermissions(DEFAULT_PERMISSIONS);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        await refreshAccounts();
      } catch {
        if (!mounted) return;
        setAccounts([]);
        setPermissions(DEFAULT_PERMISSIONS);
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    run();
    return () => {
      mounted = false;
    };
  }, [authLoading, isAuthenticated, refreshAccounts]);

  const value = useMemo(
    () => ({
      accounts,
      permissions,
      loading,
      refreshAccounts,
    }),
    [accounts, permissions, loading, refreshAccounts]
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
};
