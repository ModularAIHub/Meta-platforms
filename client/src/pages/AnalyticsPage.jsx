import React, { useEffect, useState } from 'react';
import { BarChart3, MessageCircle, Heart, Eye, Clock3, Users, AtSign } from 'lucide-react';
import { analyticsApi } from '../utils/api';
import LoadingSpinner from '../components/LoadingSpinner';

const MetricCard = ({ label, value, icon: Icon, tint = 'blue' }) => {
  const colorMap = {
    blue: 'text-blue-600',
    pink: 'text-pink-600',
    green: 'text-green-600',
    red: 'text-red-600',
    indigo: 'text-indigo-600',
    slate: 'text-slate-700',
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">{label}</p>
        <Icon className={`h-5 w-5 ${colorMap[tint] || colorMap.blue}`} />
      </div>
      <p className="text-2xl font-bold text-gray-900 mt-3">{Number(value || 0).toLocaleString()}</p>
    </div>
  );
};

const AnalyticsPage = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    let mounted = true;

    const fetchAnalytics = async () => {
      try {
        setLoading(true);
        const response = await analyticsApi.overview(days);
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

    fetchAnalytics();
    return () => {
      mounted = false;
    };
  }, [days]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const instagram = data?.instagram || {
    likes: 0,
    comments: 0,
    reach: 0,
    posts: 0,
  };

  const threads = data?.threads || {
    likes: 0,
    replies: 0,
    views: 0,
    posts: 0,
  };

  const youtube = data?.youtube || {
    views: 0,
    watchTimeMinutes: 0,
    subscribersGained: 0,
    posts: 0,
  };

  const summary = data?.summary || {
    totalPosted: 0,
    totalScheduled: 0,
    totalDeleted: 0,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Analytics</h1>
        <p className="text-gray-600 mt-1">Real aggregated stats from your saved platform posts.</p>
      </div>

      <div className="card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full md:w-auto">
            <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2">
              <p className="text-xs text-green-700">Posted</p>
              <p className="text-lg font-semibold text-green-800">{summary.totalPosted}</p>
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
              <p className="text-xs text-blue-700">Scheduled</p>
              <p className="text-lg font-semibold text-blue-800">{summary.totalScheduled}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <p className="text-xs text-gray-600">Deleted</p>
              <p className="text-lg font-semibold text-gray-700">{summary.totalDeleted}</p>
            </div>
          </div>

          <div className="w-full md:w-44">
            <label className="block text-xs font-medium text-gray-600 mb-1">Time Range</label>
            <select
              className="input"
              value={days}
              onChange={(event) => setDays(Number.parseInt(event.target.value, 10))}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last 365 days</option>
            </select>
          </div>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-pink-600" />
          <h2 className="text-xl font-semibold text-gray-900">Instagram ({instagram.posts || 0} posts)</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard label="Likes" value={instagram.likes} icon={Heart} tint="pink" />
          <MetricCard label="Comments" value={instagram.comments} icon={MessageCircle} tint="blue" />
          <MetricCard label="Reach" value={instagram.reach} icon={Eye} tint="green" />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <AtSign className="h-5 w-5 text-slate-700" />
          <h2 className="text-xl font-semibold text-gray-900">Threads ({threads.posts || 0} posts)</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard label="Likes" value={threads.likes} icon={Heart} tint="slate" />
          <MetricCard label="Replies" value={threads.replies} icon={MessageCircle} tint="blue" />
          <MetricCard label="Views" value={threads.views} icon={Eye} tint="green" />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-red-600" />
          <h2 className="text-xl font-semibold text-gray-900">YouTube ({youtube.posts || 0} posts)</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard label="Views" value={youtube.views} icon={Eye} tint="red" />
          <MetricCard label="Watch Time (minutes)" value={youtube.watchTimeMinutes} icon={Clock3} tint="indigo" />
          <MetricCard label="Subscribers Gained" value={youtube.subscribersGained} icon={Users} tint="green" />
        </div>
      </section>
    </div>
  );
};

export default AnalyticsPage;