import React, { useEffect, useMemo, useState } from 'react';
import { History as HistoryIcon, Trash2, Instagram, Youtube, AtSign, CalendarDays } from 'lucide-react';
import toast from 'react-hot-toast';
import LoadingSpinner from '../components/LoadingSpinner';
import { postsApi } from '../utils/api';
import { IS_THREADS_ONLY_MODE, THREADS_INVITE_MODE_NOTICE } from '../config/platformAvailability';

const formatDate = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString();
};

const platformMeta = {
  instagram: {
    label: 'Instagram',
    className: 'bg-pink-100 text-pink-700',
    icon: Instagram,
  },
  threads: {
    label: 'Threads',
    className: 'bg-slate-100 text-slate-700',
    icon: AtSign,
  },
  youtube: {
    label: 'YouTube',
    className: 'bg-red-100 text-red-700',
    icon: Youtube,
  },
};

const PlatformBadge = ({ platform }) => {
  const meta = platformMeta[platform] || platformMeta.threads;
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${meta.className}`}>
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
};

const statusMeta = {
  posted: 'bg-green-100 text-green-700',
  scheduled: 'bg-blue-100 text-blue-700',
  failed: 'bg-red-100 text-red-700',
  deleted: 'bg-gray-100 text-gray-600',
};

const parsePostTime = (post) =>
  new Date(post.posted_at || post.scheduled_for || post.created_at || 0).getTime();

const hasThreadsPlatform = (post) =>
  Array.isArray(post?.platforms) &&
  post.platforms.some((platform) => String(platform || '').toLowerCase() === 'threads');

const applyFallbackFilters = (posts, { status, platform, days, sort }) => {
  const now = Date.now();
  const since = Number.isFinite(days) && days > 0 ? now - (days * 24 * 60 * 60 * 1000) : null;

  return [...posts]
    .filter((post) => {
      if (status !== 'all' && String(post.status || '').toLowerCase() !== status) {
        return false;
      }

      if (platform !== 'all') {
        const platforms = Array.isArray(post.platforms) ? post.platforms.map((item) => String(item).toLowerCase()) : [];
        if (!platforms.includes(platform)) {
          return false;
        }
      }

      if (since) {
        const timestamp = parsePostTime(post);
        if (!Number.isFinite(timestamp) || timestamp < since) {
          return false;
        }
      }

      return true;
    })
    .sort((left, right) => {
      const a = parsePostTime(left);
      const b = parsePostTime(right);
      return sort === 'oldest' ? a - b : b - a;
    });
};

const HistoryPage = () => {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [platformFilter, setPlatformFilter] = useState(IS_THREADS_ONLY_MODE ? 'threads' : 'all');
  const [daysFilter, setDaysFilter] = useState(30);
  const [sort, setSort] = useState('newest');
  const [deletingId, setDeletingId] = useState(null);

  const fetchHistory = async () => {
    try {
      setLoading(true);
      const response = await postsApi.history({
        status: statusFilter,
        platform: platformFilter,
        days: daysFilter,
        sort,
        limit: 100,
      });
      setPosts(response.data?.posts || []);
    } catch (error) {
      const status = error?.response?.status;

      if (status === 404) {
        try {
          const fallbackResponse = await postsApi.recent(100);
          const fallbackPosts = fallbackResponse.data?.posts || [];
          const filtered = applyFallbackFilters(fallbackPosts, {
            status: statusFilter,
            platform: platformFilter,
            days: daysFilter,
            sort,
          });

          setPosts(filtered);
          return;
        } catch {
          // Fall through to generic error handling.
        }
      }

      toast.error(error.response?.data?.error || 'Failed to load history');
      setPosts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, [statusFilter, platformFilter, daysFilter, sort]);

  const stats = useMemo(
    () => ({
      total: posts.length,
      posted: posts.filter((post) => post.status === 'posted').length,
      scheduled: posts.filter((post) => post.status === 'scheduled').length,
      failed: posts.filter((post) => post.status === 'failed').length,
      deleted: posts.filter((post) => post.status === 'deleted').length,
    }),
    [posts]
  );

  const handleDelete = async (post) => {
    const postId = post?.id;
    if (!postId) {
      toast.error('This post cannot be deleted right now (missing id).');
      return;
    }

    const threadsSync = post?.status === 'deleted' && hasThreadsPlatform(post);
    const confirmMessage = threadsSync
      ? 'This post is already marked deleted locally. Sync delete on Threads now?'
      : 'Delete this post from history?';
    const confirmed = window.confirm(confirmMessage);
    if (!confirmed) return;

    try {
      setDeletingId(postId);
      const response = await postsApi.delete(postId);
      toast.success(response?.data?.message || 'Post deleted');
      await fetchHistory();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to delete post');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">History</h1>
        <p className="text-gray-600 mt-1">
          {IS_THREADS_ONLY_MODE
            ? 'Posted and scheduled Threads content.'
            : 'Posted and scheduled content across all platforms.'}
        </p>
      </div>

      {IS_THREADS_ONLY_MODE && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-800">
          <p className="text-sm font-medium">Threads-only mode</p>
          <p className="text-sm mt-1">{THREADS_INVITE_MODE_NOTICE}</p>
        </div>
      )}

      <div className="card space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="rounded-lg border border-gray-200 px-3 py-2">
            <p className="text-xs text-gray-500">Total</p>
            <p className="text-xl font-semibold text-gray-900">{stats.total}</p>
          </div>
          <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2">
            <p className="text-xs text-green-700">Posted</p>
            <p className="text-xl font-semibold text-green-800">{stats.posted}</p>
          </div>
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
            <p className="text-xs text-blue-700">Scheduled</p>
            <p className="text-xl font-semibold text-blue-800">{stats.scheduled}</p>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
            <p className="text-xs text-red-700">Failed</p>
            <p className="text-xl font-semibold text-red-800">{stats.failed}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <p className="text-xs text-gray-600">Deleted</p>
            <p className="text-xl font-semibold text-gray-700">{stats.deleted}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <select className="input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All Status</option>
            <option value="posted">Posted</option>
            <option value="scheduled">Scheduled</option>
            <option value="failed">Failed</option>
            <option value="deleted">Deleted</option>
          </select>

          <select className="input" value={platformFilter} onChange={(event) => setPlatformFilter(event.target.value)}>
            <option value="all">{IS_THREADS_ONLY_MODE ? 'All (Threads)' : 'All Platforms'}</option>
            {!IS_THREADS_ONLY_MODE && <option value="instagram">Instagram</option>}
            <option value="threads">Threads</option>
            {!IS_THREADS_ONLY_MODE && <option value="youtube">YouTube</option>}
          </select>

          <select className="input" value={daysFilter} onChange={(event) => setDaysFilter(Number.parseInt(event.target.value, 10))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 365 days</option>
          </select>

          <select className="input" value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
      </div>

      {posts.length === 0 ? (
        <div className="card text-center">
          <HistoryIcon className="h-10 w-10 text-gray-400 mx-auto mb-2" />
          <p className="text-gray-600">No posts found for the selected filters.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {posts.map((post) => (
            <div key={post.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2 flex-1 min-w-0">
                  <div className="flex flex-wrap gap-2">
                    {(post.platforms || []).map((platform) => (
                      <PlatformBadge key={`${post.id}-${platform}`} platform={platform} />
                    ))}
                    <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${statusMeta[post.status] || statusMeta.deleted}`}>
                      {post.status || 'unknown'}
                    </span>
                  </div>

                  <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                    {post.caption || '(No caption)'}
                  </p>

                  <div className="inline-flex items-center gap-2 text-xs text-gray-500">
                    <CalendarDays className="h-3 w-3" />
                    {formatDate(post.posted_at || post.scheduled_for || post.created_at)}
                  </div>
                </div>

                {(() => {
                  const retryThreadsDelete = post.status === 'deleted' && hasThreadsPlatform(post);
                  const disabled = !post.id || deletingId === post.id || (post.status === 'deleted' && !retryThreadsDelete);
                  const label = deletingId === post.id
                    ? 'Deleting...'
                    : retryThreadsDelete
                      ? 'Sync delete'
                      : post.status === 'deleted'
                        ? 'Deleted'
                        : 'Delete';

                  return (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
                  disabled={disabled}
                  onClick={() => handleDelete(post)}
                >
                  <Trash2 className="h-4 w-4" />
                  {label}
                </button>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default HistoryPage;
