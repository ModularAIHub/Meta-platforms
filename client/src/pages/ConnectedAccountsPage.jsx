import React, { useEffect, useMemo, useState } from 'react';
import { Instagram, Youtube, AtSign, Link2, Unlink, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { accountsApi, oauthApi } from '../utils/api';
import { useAccounts } from '../contexts/AccountContext';
import {
  IS_THREADS_ONLY_MODE,
  THREADS_INVITE_MODE_NOTICE,
  isSocialPlatformEnabled,
} from '../config/platformAvailability';

const PlatformIcon = ({ platform }) => {
  if (platform === 'instagram') {
    return <Instagram className="h-5 w-5 text-pink-600" />;
  }

  if (platform === 'threads') {
    return <AtSign className="h-5 w-5 text-slate-700" />;
  }

  return <Youtube className="h-5 w-5 text-red-600" />;
};

const ConnectedAccountsPage = () => {
  const { accounts, permissions, loading, refreshAccounts } = useAccounts();
  const [disconnectingId, setDisconnectingId] = useState(null);
  const [connectingByok, setConnectingByok] = useState(false);
  const [instagramByokToken, setInstagramByokToken] = useState('');
  const [instagramByokAccountId, setInstagramByokAccountId] = useState('');
  const [instagramByokPageId, setInstagramByokPageId] = useState('');

  const canManageConnections = Boolean(permissions?.canManageConnections);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('error');

    if (connected) {
      toast.success(`${connected} account connected`);
      refreshAccounts();
      window.history.replaceState({}, '', '/accounts');
    }

    if (error) {
      toast.error(error.replace(/_/g, ' '));
      window.history.replaceState({}, '', '/accounts');
    }
  }, [refreshAccounts]);

  const activeCounts = useMemo(() => {
    return {
      instagram: accounts.filter((account) => account.platform === 'instagram').length,
      youtube: accounts.filter((account) => account.platform === 'youtube').length,
      threads: accounts.filter((account) => account.platform === 'threads').length,
    };
  }, [accounts]);

  const visibleAccounts = useMemo(() => accounts, [accounts]);
  const instagramLocked = IS_THREADS_ONLY_MODE && !isSocialPlatformEnabled('instagram');
  const youtubeLocked = IS_THREADS_ONLY_MODE && !isSocialPlatformEnabled('youtube');

  const connectPlatform = (platform) => {
    if (!isSocialPlatformEnabled(platform)) {
      toast.error('This platform is not available in production yet.');
      return;
    }

    const returnUrl = `${window.location.origin}/accounts`;
    // Pass teamId as query param so the server gets it even without x-team-id header
    // (browser navigations don't send custom headers via axios interceptors).
    const teamId = permissions?.teamId || null;
    const connectUrl = oauthApi.connectUrl(platform, returnUrl, teamId);
    window.location.href = connectUrl;
  };

  const disconnectAccount = async (accountId) => {
    setDisconnectingId(accountId);
    try {
      await accountsApi.disconnect(accountId);
      toast.success('Account disconnected');
      await refreshAccounts();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to disconnect account');
    } finally {
      setDisconnectingId(null);
    }
  };

  const connectInstagramByok = async () => {
    const accessToken = instagramByokToken.trim();
    const instagramAccountId = instagramByokAccountId.trim();
    const facebookPageId = instagramByokPageId.trim();

    if (!accessToken) {
      toast.error('Instagram access token is required');
      return;
    }

    if (!instagramAccountId) {
      toast.error('Instagram account ID is required');
      return;
    }

    setConnectingByok(true);
    try {
      const response = await accountsApi.connectInstagramByok({
        access_token: accessToken,
        instagram_account_id: instagramAccountId,
        facebook_page_id: facebookPageId || null,
      });

      const expiresInDays = response.data?.token?.expiresInDays;
      if (Number.isInteger(expiresInDays)) {
        toast.success(`Instagram connected. Token expires in ${expiresInDays} day(s).`);
      } else {
        toast.success('Instagram connected with token');
      }

      setInstagramByokToken('');
      setInstagramByokAccountId('');
      setInstagramByokPageId('');
      await refreshAccounts();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to connect Instagram token');
    } finally {
      setConnectingByok(false);
    }
  };

  const getExpiryMeta = (value) => {
    if (!value) {
      return null;
    }

    const expiresAtMs = new Date(value).getTime();
    if (!Number.isFinite(expiresAtMs)) {
      return null;
    }

    const msRemaining = expiresAtMs - Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const daysRemaining = Math.floor(msRemaining / dayMs);

    return {
      expired: msRemaining <= 0,
      expiringSoon: msRemaining > 0 && daysRemaining <= 7,
      label: new Date(expiresAtMs).toLocaleDateString(),
      daysRemaining: Math.max(0, daysRemaining),
    };
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Connected Accounts</h1>
        <p className="text-gray-600 mt-1">Connect and manage Instagram + Threads + YouTube accounts.</p>
      </div>

      {IS_THREADS_ONLY_MODE && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-800">
          <p className="text-sm font-medium">Threads-only mode</p>
          <p className="text-sm mt-1">
            {THREADS_INVITE_MODE_NOTICE} Instagram and YouTube are visible but locked in production for now.
          </p>
        </div>
      )}

      {!canManageConnections && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800">
          <div className="inline-flex items-center gap-2 font-medium">
            <ShieldAlert className="h-4 w-4" />
            Owner/Admin required
          </div>
          <p className="text-sm mt-1">Only owner/admin can connect or disconnect accounts. All roles can still create posts.</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className={`card ${instagramLocked ? 'opacity-80' : ''}`}>
          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-2 font-semibold text-gray-900">
              <Instagram className="h-5 w-5 text-pink-600" />
              Instagram
            </div>
            <span className="text-xs bg-pink-100 text-pink-700 rounded-full px-2 py-1">{activeCounts.instagram} connected</span>
          </div>

          <button
            type="button"
            onClick={() => connectPlatform('instagram')}
            disabled={!canManageConnections || instagramLocked}
            className={`btn mt-4 h-10 px-4 ${
              instagramLocked
                ? 'border border-gray-300 bg-gray-100 text-gray-500'
                : 'btn-primary'
            }`}
          >
            <Link2 className="h-4 w-4 mr-2" />
            Connect Instagram
          </button>

          {instagramLocked ? (
            <p className="text-xs text-gray-600 mt-4">
              Locked in production. Available in development and after app review approval.
            </p>
          ) : (
            <div className="mt-4 border-t border-gray-200 pt-4 space-y-2">
              <p className="text-xs text-gray-600">
                Local-dev fallback: paste your own token from{' '}
                <a
                  href="https://developers.facebook.com/tools/explorer"
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 underline"
                >
                  Meta Graph API Explorer
                </a>
                .
              </p>
              <input
                type="password"
                className="input"
                placeholder="Instagram access token"
                value={instagramByokToken}
                onChange={(event) => setInstagramByokToken(event.target.value)}
                disabled={!canManageConnections || connectingByok}
              />
              <input
                type="text"
                className="input"
                placeholder="Instagram Business Account ID"
                value={instagramByokAccountId}
                onChange={(event) => setInstagramByokAccountId(event.target.value)}
                disabled={!canManageConnections || connectingByok}
              />
              <input
                type="text"
                className="input"
                placeholder="Facebook Page ID (optional)"
                value={instagramByokPageId}
                onChange={(event) => setInstagramByokPageId(event.target.value)}
                disabled={!canManageConnections || connectingByok}
              />
              <button
                type="button"
                onClick={connectInstagramByok}
                disabled={!canManageConnections || connectingByok}
                className="btn btn-primary h-10 px-4"
              >
                {connectingByok ? 'Connecting...' : 'Connect With Token'}
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-2 font-semibold text-gray-900">
              <AtSign className="h-5 w-5 text-slate-700" />
              Threads
            </div>
            <span className="text-xs bg-slate-100 text-slate-700 rounded-full px-2 py-1">{activeCounts.threads} connected</span>
          </div>

          <button
            type="button"
            onClick={() => connectPlatform('threads')}
            disabled={!canManageConnections}
            className="btn btn-primary mt-4 h-10 px-4"
          >
            <Link2 className="h-4 w-4 mr-2" />
            Connect Threads
          </button>

          <p className="text-xs text-gray-600 mt-4">
            {IS_THREADS_ONLY_MODE
              ? `${THREADS_INVITE_MODE_NOTICE} Use one-click Threads OAuth if your app is approved/invited.`
              : 'Uses one-click Threads OAuth. Configure `THREADS_APP_ID/THREADS_APP_SECRET` (or reuse Instagram keys).'}
          </p>
        </div>

        <div className={`card ${youtubeLocked ? 'opacity-80' : ''}`}>
          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-2 font-semibold text-gray-900">
              <Youtube className="h-5 w-5 text-red-600" />
              YouTube
            </div>
            <span className="text-xs bg-red-100 text-red-700 rounded-full px-2 py-1">{activeCounts.youtube} connected</span>
          </div>

          <button
            type="button"
            onClick={() => connectPlatform('youtube')}
            disabled={!canManageConnections || youtubeLocked}
            className={`btn mt-4 h-10 px-4 ${
              youtubeLocked
                ? 'border border-gray-300 bg-gray-100 text-gray-500'
                : 'btn-primary'
            }`}
          >
            <Link2 className="h-4 w-4 mr-2" />
            Connect YouTube
          </button>
          {youtubeLocked && (
            <p className="text-xs text-gray-600 mt-4">
              Locked in production. Available in development and after app review approval.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Active Connections</h2>

        {loading ? (
          <p className="text-sm text-gray-500">Loading accounts...</p>
        ) : visibleAccounts.length === 0 ? (
          <p className="text-sm text-gray-500">No connected accounts yet.</p>
        ) : (
          <div className="space-y-3">
            {visibleAccounts.map((account) => {
              const expiry = getExpiryMeta(account.token_expires_at);

              return (
                <div key={account.id} className="rounded-lg border border-gray-200 p-4 flex items-center justify-between">
                  <div>
                    <div className="inline-flex items-center gap-2 font-medium text-gray-900">
                      <PlatformIcon platform={account.platform} />
                      {account.account_display_name || account.account_username || account.account_id}
                    </div>
                    <p className="text-sm text-gray-500 mt-1">{account.platform} {account.account_username ? `@${account.account_username}` : ''}</p>
                    {expiry?.expired && (
                      <p className="text-xs mt-1 text-red-600">Token expired. Reconnect account.</p>
                    )}
                    {!expiry?.expired && expiry?.expiringSoon && (
                      <p className="text-xs mt-1 text-amber-600">
                        Token expires in {expiry.daysRemaining} day(s) ({expiry.label})
                      </p>
                    )}
                    {!expiry?.expired && !expiry?.expiringSoon && expiry && (
                      <p className="text-xs mt-1 text-gray-500">
                        Token expires in {expiry.daysRemaining} day(s) ({expiry.label})
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
                    onClick={() => disconnectAccount(account.id)}
                    disabled={!canManageConnections || disconnectingId === account.id}
                  >
                    <Unlink className="h-4 w-4 inline mr-1" />
                    {disconnectingId === account.id ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default ConnectedAccountsPage;
