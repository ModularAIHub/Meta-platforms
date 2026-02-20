import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Clock3, Instagram, Youtube, AtSign } from 'lucide-react';
import toast from 'react-hot-toast';
import { scheduleApi } from '../utils/api';
import LoadingSpinner from '../components/LoadingSpinner';

const formatDate = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString();
};

const toLocalDateTimeInput = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const tzOffsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffsetMs).toISOString().slice(0, 16);
};

const PlatformBadge = ({ platform }) => {
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

const statusClass = {
  scheduled: 'bg-blue-100 text-blue-700',
  publishing: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
  posted: 'bg-emerald-100 text-emerald-700',
  deleted: 'bg-gray-100 text-gray-700',
};

const SchedulePage = () => {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionPostId, setActionPostId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('active');

  const fetchSchedule = useCallback(async () => {
    try {
      setLoading(true);
      const response = await scheduleApi.list({ status: statusFilter });
      setPosts(response.data?.posts || []);
    } catch {
      setPosts([]);
      toast.error('Failed to load scheduled posts');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  const groupedByDay = useMemo(() => {
    return posts.reduce((acc, post) => {
      const date = new Date(post.scheduled_for || post.created_at);
      const key = Number.isNaN(date.getTime()) ? 'Unknown Date' : date.toDateString();
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(post);
      return acc;
    }, {});
  }, [posts]);

  const runAction = async (postId, action) => {
    setActionPostId(postId);
    try {
      await action();
      await fetchSchedule();
    } finally {
      setActionPostId(null);
    }
  };

  const handleRetry = async (post) => {
    await runAction(post.id, async () => {
      await scheduleApi.retry(post.id);
      toast.success('Post queued for retry');
    });
  };

  const handleCancel = async (post) => {
    const ok = window.confirm('Cancel this scheduled post?');
    if (!ok) return;

    await runAction(post.id, async () => {
      await scheduleApi.cancel(post.id);
      toast.success('Scheduled post cancelled');
    });
  };

  const handleReschedule = async (post) => {
    const current = toLocalDateTimeInput(post.scheduled_for || new Date().toISOString());
    const next = window.prompt('Enter new schedule time (YYYY-MM-DDTHH:mm)', current);
    if (!next) return;

    const nextDate = new Date(next);
    if (Number.isNaN(nextDate.getTime())) {
      toast.error('Invalid date/time format');
      return;
    }

    await runAction(post.id, async () => {
      await scheduleApi.reschedule(post.id, { scheduledFor: nextDate.toISOString() });
      toast.success('Post rescheduled');
    });
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Schedule / Calendar</h1>
          <p className="text-gray-600 mt-1">Manage scheduled, publishing, and failed posts.</p>
        </div>

        <select
          className="input max-w-[180px]"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="active">Active</option>
          <option value="all">All statuses</option>
          <option value="scheduled">Scheduled</option>
          <option value="publishing">Publishing</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {posts.length === 0 ? (
        <div className="card text-center">
          <CalendarDays className="h-10 w-10 text-gray-400 mx-auto mb-2" />
          <p className="text-gray-600">No posts for this filter.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(groupedByDay).map(([dateKey, datePosts]) => (
            <div key={dateKey} className="card">
              <h2 className="text-lg font-semibold text-gray-900 mb-3">{dateKey}</h2>
              <div className="space-y-3">
                {datePosts.map((post) => {
                  const status = String(post.status || '').toLowerCase();
                  const isBusy = actionPostId === post.id;

                  return (
                    <div key={post.id} className="rounded-lg border border-gray-200 p-4 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {(post.platforms || []).map((platform) => (
                            <PlatformBadge key={`${post.id}-${platform}`} platform={platform} />
                          ))}
                        </div>
                        <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${statusClass[status] || 'bg-gray-100 text-gray-700'}`}>
                          {status || 'unknown'}
                        </span>
                      </div>

                      <p className="text-sm text-gray-800 whitespace-pre-wrap">{post.caption || 'No caption'}</p>

                      <div className="inline-flex items-center gap-2 text-xs text-gray-500">
                        <Clock3 className="h-3 w-3" />
                        {formatDate(post.scheduled_for || post.created_at)}
                      </div>

                      <div className="flex flex-wrap gap-2 pt-1">
                        {status !== 'deleted' && status !== 'posted' && (
                          <button
                            type="button"
                            onClick={() => handleReschedule(post)}
                            disabled={isBusy}
                            className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Reschedule
                          </button>
                        )}

                        {status === 'failed' && (
                          <button
                            type="button"
                            onClick={() => handleRetry(post)}
                            disabled={isBusy}
                            className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                          >
                            Retry Now
                          </button>
                        )}

                        {status !== 'deleted' && status !== 'posted' && (
                          <button
                            type="button"
                            onClick={() => handleCancel(post)}
                            disabled={isBusy}
                            className="rounded-md border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SchedulePage;
