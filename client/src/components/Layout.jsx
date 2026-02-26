import React, { useEffect, useState, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  PenSquare,
  CalendarDays,
  BarChart3,
  Link2,
  LogOut,
  Menu,
  X,
  ChevronDown,
  Shield,
  Wallet,
  History as HistoryIcon,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useAccounts } from '../contexts/AccountContext';
import { creditsApi } from '../utils/api';

// How often to passively refresh credits in the background
const CREDITS_POLL_MS = 5 * 60 * 1000; // 5 minutes (was 60s)

// How long to wait after window focus before re-fetching
// Prevents hammering the API when users switch tabs rapidly
const CREDITS_FOCUS_DEBOUNCE_MS = 3000; // 3 seconds

const Layout = ({ children }) => {
  const { user, logout } = useAuth();
  const { permissions } = useAccounts();
  const location = useLocation();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const isTeamContext = Boolean(permissions?.isTeamMember || permissions?.teamId);
  const [creditBalance, setCreditBalance] = useState(null);
  const [creditScope, setCreditScope] = useState('personal');

  // Refs to manage debounce and mount state without causing re-renders
  const mountedRef = useRef(true);
  const focusDebounceRef = useRef(null);
  const lastFetchRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!user?.id) {
      setCreditBalance(null);
      setCreditScope('personal');
      return;
    }

    const fetchCredits = async () => {
      // Skip if fetched very recently (handles rapid focus/visibility events)
      const now = Date.now();
      if (now - lastFetchRef.current < 10000) return; // 10s minimum between fetches
      lastFetchRef.current = now;

      try {
        const response = await creditsApi.balance();
        const payload = response?.data || {};
        const parsedBalance = Number.parseFloat(
          payload.balance ?? payload.creditsRemaining ?? '0'
        );

        if (!mountedRef.current) return;
        setCreditBalance(Number.isFinite(parsedBalance) ? parsedBalance : 0);
        setCreditScope(payload.scope || payload.source || 'personal');
      } catch {
        if (!mountedRef.current) return;
        setCreditBalance(null);
        setCreditScope('personal');
      }
    };

    // Initial fetch on mount — no debounce
    fetchCredits();

    // Poll every 5 minutes (only if tab is visible)
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchCredits();
      }
    }, CREDITS_POLL_MS);

    // Debounced focus handler — waits 3s after focus before fetching
    // so rapid tab-switching doesn't spam the API
    const onWindowFocus = () => {
      clearTimeout(focusDebounceRef.current);
      focusDebounceRef.current = setTimeout(() => {
        if (mountedRef.current) fetchCredits();
      }, CREDITS_FOCUS_DEBOUNCE_MS);
    };

    // Visibility change — only fetch when becoming visible after being hidden
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(focusDebounceRef.current);
        focusDebounceRef.current = setTimeout(() => {
          if (mountedRef.current) fetchCredits();
        }, CREDITS_FOCUS_DEBOUNCE_MS);
      }
    };

    window.addEventListener('focus', onWindowFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(interval);
      clearTimeout(focusDebounceRef.current);
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [user?.id, permissions?.teamId]);

  const navigation = [
    { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { name: 'Create Post', href: '/create-post', icon: PenSquare },
    { name: 'Schedule', href: '/schedule', icon: CalendarDays },
    { name: 'History', href: '/history', icon: HistoryIcon },
    { name: 'Analytics', href: '/analytics', icon: BarChart3 },
    { name: 'Connected Accounts', href: '/accounts', icon: Link2 },
  ];

  const isActive = (href) => location.pathname === href;

  return (
    <div className="h-screen overflow-hidden bg-gray-50 flex">
      {isSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-gray-600 bg-opacity-75 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white shadow-lg transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:sticky lg:top-0 lg:h-screen lg:flex lg:flex-col ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between h-16 px-6 border-b border-gray-200">
          <span className="text-xl font-bold text-blue-700">Meta Genie</span>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="lg:hidden p-2 rounded-md text-gray-400 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 mt-6 px-4 overflow-y-auto">
          <ul className="space-y-2">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.name}>
                  <Link
                    to={item.href}
                    className={`flex items-center px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                      isActive(item.href)
                        ? 'bg-primary-50 text-primary-700 border-r-2 border-primary-700'
                        : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Icon className="mr-3 h-5 w-5" />
                    {item.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="p-4 border-t border-gray-200 space-y-3">
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-4">
            <div className="flex items-center gap-2 text-sm text-blue-700 font-medium">
              <Wallet className="h-4 w-4" />
              Credits
            </div>
            <p className="text-lg font-semibold text-blue-900 mt-1">
              {creditBalance !== null ? creditBalance.toFixed(1) : '--'}
            </p>
            <p className="text-xs text-blue-600 mt-1">
              {creditScope === 'team' ? 'Available team credits' : 'Available credits'}
            </p>
          </div>

          {isTeamContext && (
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center gap-2 text-sm text-gray-700 font-medium">
                <Shield className="h-4 w-4" />
                Role
              </div>
              <p className="text-lg font-semibold text-gray-900 mt-1 capitalize">
                {permissions?.role || 'viewer'}
              </p>
            </div>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white shadow-sm border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center justify-between h-16 px-4 sm:px-6 lg:px-8">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="lg:hidden p-2 rounded-md text-gray-400 hover:text-gray-600"
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="flex items-center space-x-4 ml-auto">
              <div className="relative">
                <button
                  onClick={() => setIsUserMenuOpen((v) => !v)}
                  className="flex items-center space-x-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <span className="hidden sm:block">{user?.email || 'User'}</span>
                  <ChevronDown className="h-4 w-4" />
                </button>

                {isUserMenuOpen && (
                  <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                    <button
                      onClick={() => {
                        setIsUserMenuOpen(false);
                        logout();
                      }}
                      className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <LogOut className="inline h-4 w-4 mr-2" />
                      Logout
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-auto">{children}</main>
      </div>
    </div>
  );
};

export default Layout;
