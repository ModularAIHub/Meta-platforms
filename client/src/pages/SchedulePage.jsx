import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Clock3, Instagram, Youtube, AtSign } from 'lucide-react';
import toast from 'react-hot-toast';
import { scheduleApi } from '../utils/api';
import LoadingSpinner from '../components/LoadingSpinner';

const TIMEZONE_ALIAS_MAP = {
  'Asia/Calcutta': 'Asia/Kolkata',
};

const normalizeTimezone = (timezone) => {
  if (!timezone) return null;
  return TIMEZONE_ALIAS_MAP[timezone] || timezone;
};

const hasExplicitTimezone = (value) => /(?:[zZ]|[+\-]\d{2}:?\d{2})$/.test(value);

const parseUtcDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = hasExplicitTimezone(raw)
    ? raw
    : `${raw.replace(' ', 'T')}Z`;

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isValidTimezone = (timezone) => {
  if (!timezone) return false;
  const normalized = normalizeTimezone(timezone);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const formatDatePart = (value, timezone) => {
  const date = parseUtcDate(value);
  if (!date) return '--';

  const options = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };
  const normalized = normalizeTimezone(timezone);
  if (isValidTimezone(normalized)) {
    options.timeZone = normalized;
  }
  return new Intl.DateTimeFormat('en-US', options).format(date);
};

const formatTimePart = (value, timezone) => {
  const date = parseUtcDate(value);
  if (!date) return '--';

  const options = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  };
  const normalized = normalizeTimezone(timezone);
  if (isValidTimezone(normalized)) {
    options.timeZone = normalized;
  }
  return new Intl.DateTimeFormat('en-US', options).format(date);
};

const toLocalDateTimeInput = (value) => {
  if (!value) return '';
  const date = parseUtcDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
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
  const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
      const date = parseUtcDate(post.scheduled_for || post.created_at);
      const key = !date || Number.isNaN(date.getTime()) ? 'Unknown Date' : date.toDateString();
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
                  const isExternal = Boolean(post.is_external_cross_post || post.external_read_only);
                  const externalSourceLabel =
                    post.external_source === 'linkedin-genie'
                      ? 'LinkedIn Genie'
                      : post.external_source === 'tweet-genie'
                        ? 'Tweet Genie'
                        : 'External';
                  const timezoneLabel = isValidTimezone(post.timezone)
                    ? normalizeTimezone(post.timezone)
                    : null;
                  const displayTimezone = timezoneLabel || userTimezone;

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
                      {isExternal && (
                        <div className="text-xs">
                          <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-1 font-medium text-violet-700">
                            External · {externalSourceLabel} cross-post (read-only)
                          </span>
                        </div>
                      )}

                      <div className="inline-flex items-center gap-2 text-xs text-gray-500">
                        <Clock3 className="h-3 w-3" />
                        <span>
                          {formatDatePart(post.scheduled_for || post.created_at, displayTimezone)}
                          {' · '}
                          {formatTimePart(post.scheduled_for || post.created_at, displayTimezone)}
                          {timezoneLabel ? ` (${timezoneLabel})` : ''}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-2 pt-1">
                        {isExternal ? (
                          <span className="rounded-md border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-500">
                            Managed in {externalSourceLabel}
                          </span>
                        ) : status !== 'deleted' && status !== 'posted' && (
                          <button
                            type="button"
                            onClick={() => handleReschedule(post)}
                            disabled={isBusy}
                            className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Reschedule
                          </button>
                        )}

                        {!isExternal && status === 'failed' && (
                          <button
                            type="button"
                            onClick={() => handleRetry(post)}
                            disabled={isBusy}
                            className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                          >
                            Retry Now
                          </button>
                        )}

                        {!isExternal && status !== 'deleted' && status !== 'posted' && (
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
