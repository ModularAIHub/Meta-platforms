import { query } from '../config/database.js';

export const getAnalyticsOverview = async (req, res) => {
  try {
    const userId = req.user.id;
    const { teamId, isTeamMember } = req.teamContext || {};
    const days = Math.max(1, Math.min(Number.parseInt(req.query.days || '30', 10), 365));

    const condition = isTeamMember && teamId
      ? 'team_id = $1'
      : 'user_id = $1 AND team_id IS NULL';

    const identifier = isTeamMember && teamId ? teamId : userId;

    const metricsResult = await query(
      `SELECT
         COALESCE(SUM(instagram_likes), 0) AS instagram_likes,
         COALESCE(SUM(instagram_comments), 0) AS instagram_comments,
         COALESCE(SUM(instagram_reach), 0) AS instagram_reach,
         COALESCE(SUM(youtube_views), 0) AS youtube_views,
         COALESCE(SUM(youtube_watch_time_minutes), 0) AS youtube_watch_time_minutes,
         COALESCE(SUM(youtube_subscribers_gained), 0) AS youtube_subscribers_gained,
         COALESCE(SUM(threads_likes), 0) AS threads_likes,
         COALESCE(SUM(threads_replies), 0) AS threads_replies,
         COALESCE(SUM(threads_views), 0) AS threads_views
       FROM social_posts
       WHERE ${condition}
         AND status = 'posted'
         AND COALESCE(posted_at, created_at) >= NOW() - ($2::text || ' days')::interval`,
      [identifier, days]
    );

    const countResult = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'posted')::bigint AS total_posted,
         COUNT(*) FILTER (WHERE status = 'scheduled')::bigint AS total_scheduled,
         COUNT(*) FILTER (WHERE status = 'deleted')::bigint AS total_deleted,
         COUNT(*) FILTER (WHERE status = 'posted' AND platforms ? 'instagram')::bigint AS instagram_posts,
         COUNT(*) FILTER (WHERE status = 'posted' AND platforms ? 'threads')::bigint AS threads_posts,
         COUNT(*) FILTER (WHERE status = 'posted' AND platforms ? 'youtube')::bigint AS youtube_posts
       FROM social_posts
       WHERE ${condition}
         AND COALESCE(posted_at, scheduled_for, created_at) >= NOW() - ($2::text || ' days')::interval`,
      [identifier, days]
    );

    const row = metricsResult.rows[0] || {};
    const counts = countResult.rows[0] || {};

    return res.json({
      success: true,
      days,
      instagram: {
        likes: Number.parseInt(row.instagram_likes || '0', 10),
        comments: Number.parseInt(row.instagram_comments || '0', 10),
        reach: Number.parseInt(row.instagram_reach || '0', 10),
        posts: Number.parseInt(counts.instagram_posts || '0', 10),
      },
      youtube: {
        views: Number.parseInt(row.youtube_views || '0', 10),
        watchTimeMinutes: Number.parseFloat(row.youtube_watch_time_minutes || '0'),
        subscribersGained: Number.parseInt(row.youtube_subscribers_gained || '0', 10),
        posts: Number.parseInt(counts.youtube_posts || '0', 10),
      },
      threads: {
        likes: Number.parseInt(row.threads_likes || '0', 10),
        replies: Number.parseInt(row.threads_replies || '0', 10),
        views: Number.parseInt(row.threads_views || '0', 10),
        posts: Number.parseInt(counts.threads_posts || '0', 10),
      },
      summary: {
        totalPosted: Number.parseInt(counts.total_posted || '0', 10),
        totalScheduled: Number.parseInt(counts.total_scheduled || '0', 10),
        totalDeleted: Number.parseInt(counts.total_deleted || '0', 10),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch analytics', details: error.message });
  }
};
