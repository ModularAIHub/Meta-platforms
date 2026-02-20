import React, { useEffect, useState } from 'react';
import { BarChart3, Heart, Users, Video, Instagram, Youtube, AtSign, Link2, ShieldAlert, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { dashboardApi, oauthApi } from '../utils/api';
import { useAccounts } from '../contexts/AccountContext';
import LoadingSpinner from '../components/LoadingSpinner';

const formatDateTime = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString();
};

const AccountPill = ({ platform }) => {
  if (platform === 'instagram') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium bg-pink-100 text-pink-700">
        <Instagram className="h-3 w-3" />
        Instagram
      </span>
    );
  }

  if (platform === 'threads') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium bg-slate-100 text-slate-700">
        <AtSign className="h-3 w-3" />
        Threads
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium bg-red-100 text-red-700">
      <Youtube className="h-3 w-3" />
      YouTube
    </span>
  );
};

const DashboardPage = () => {
  const {
    accounts,
    permissions,
    loading: accountsLoading,
    refreshAccounts,
  } = useAccounts();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const canManageConnections = Boolean(permissions?.canManageConnections);

  const connectPlatform = (platform) => {
    const returnUrl = `${window.location.origin}/dashboard`;
    const connectUrl = oauthApi.connectUrl(platform, returnUrl);
    window.location.href = connectUrl;
  };

  useEffect(() => {
    let mounted = true;

    const fetchDashboard = async () => {
      try {
        setLoading(true);
        const response = await dashboardApi.get();
        if (mounted) {
          setData(response.data || null);
        }
      } catch {
        if (mounted) {
          setData(null);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchDashboard();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('error');

    if (connected) {
      toast.success(`${connected} account connected`);
      refreshAccounts();
      window.history.replaceState({}, '', '/dashboard');
    }

    if (error) {
      toast.error(error.replace(/_/g, ' '));
      window.history.replaceState({}, '', '/dashboard');
    }
  }, [refreshAccounts]);

  if (loading || accountsLoading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const stats = data?.quickStats || {
    likes: 0,
    views: 0,
    followers: 0,
    totalPosts: 0,
  };
  const credits = data?.credits || null;

  const recentPosts = data?.recentPosts || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-1">
          Connected Instagram + Threads + YouTube accounts, post activity, and engagement snapshot.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        <div className="card">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">Total Likes</p>
            <Heart className="h-5 w-5 text-pink-600" />
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-3">{Number(stats.likes || 0).toLocaleString()}</p>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">Total Views</p>
            <Video className="h-5 w-5 text-red-600" />
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-3">{Number(stats.views || 0).toLocaleString()}</p>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">Followers/Subscribers</p>
            <Users className="h-5 w-5 text-blue-600" />
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-3">{Number(stats.followers || 0).toLocaleString()}</p>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">Total Posts</p>
            <BarChart3 className="h-5 w-5 text-indigo-600" />
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-3">{Number(stats.totalPosts || 0).toLocaleString()}</p>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">Credits</p>
            <Wallet className="h-5 w-5 text-emerald-600" />
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-3">
            {credits
              ? Number(credits.balance || credits.creditsRemaining || 0).toLocaleString()
              : '--'}
          </p>
          <p className="text-xs text-gray-500 mt-1 capitalize">
            {credits ? (credits.scope || credits.source || 'personal') : 'unavailable'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="card xl:col-span-1">
          <h2 className="text-lg font-semibold text-gray-900">Connected Accounts</h2>
          <p className="text-sm text-gray-500 mb-4">{accounts.length} account(s) active</p>

          {accounts.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">No accounts connected yet.</p>

              <button
                type="button"
                className="btn btn-primary h-9 px-3"
                onClick={() => connectPlatform('instagram')}
                disabled={!canManageConnections}
              >
                <Link2 className="h-4 w-4 mr-2" />
                Connect Instagram
              </button>

              <button
                type="button"
                className="btn h-9 px-3 border border-gray-300 text-gray-700 hover:bg-gray-50"
                onClick={() => connectPlatform('threads')}
                disabled={!canManageConnections}
              >
                <Link2 className="h-4 w-4 mr-2" />
                Connect Threads
              </button>

              <button
                type="button"
                className="btn h-9 px-3 border border-gray-300 text-gray-700 hover:bg-gray-50"
                onClick={() => connectPlatform('youtube')}
                disabled={!canManageConnections}
              >
                <Link2 className="h-4 w-4 mr-2" />
                Connect YouTube
              </button>

              {!canManageConnections && (
                <div className="inline-flex items-center gap-1 text-xs text-amber-700">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Owner/Admin role required to connect accounts
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {accounts.map((account) => (
                <div key={account.id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-gray-900">{account.account_display_name || account.account_username}</p>
                    <AccountPill platform={account.platform} />
                  </div>
                  <p className="text-sm text-gray-500 mt-1">@{account.account_username || account.account_id}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card xl:col-span-2">
          <h2 className="text-lg font-semibold text-gray-900">Recent Posts</h2>
          <p className="text-sm text-gray-500 mb-4">Latest post and schedule activity</p>

          {recentPosts.length === 0 ? (
            <p className="text-sm text-gray-500">No posts yet. Create your first post from the Create Post page.</p>
          ) : (
            <div className="space-y-3">
              {recentPosts.map((post) => (
                <div key={post.id} className="rounded-lg border border-gray-200 p-4">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    {(post.platforms || []).map((platform) => (
                      <AccountPill key={`${post.id}-${platform}`} platform={platform} />
                    ))}
                    <span className="text-xs font-medium rounded-full px-2 py-1 bg-gray-100 text-gray-700 uppercase">
                      {post.status}
                    </span>
                  </div>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">{post.caption || 'No caption'}</p>
                  <p className="text-xs text-gray-500 mt-2">
                    {post.status === 'scheduled' ? 'Scheduled' : 'Updated'}: {formatDateTime(post.scheduled_for || post.updated_at)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
