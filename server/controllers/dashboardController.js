import { query } from '../config/database.js';
import { TeamCreditService } from '../services/teamCreditService.js';
import { creditService } from '../services/creditService.js';

const resolveUserToken = (req) => {
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return req.platformAccessToken || bearerToken || req.cookies?.accessToken || null;
};

export const getDashboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const { teamId, isTeamMember } = req.teamContext || {};
    const userToken = resolveUserToken(req);

    const accountResult = isTeamMember && teamId
      ? await query(
          `SELECT id, platform, account_id, account_username, account_display_name, profile_image_url, followers_count
           FROM social_connected_accounts
           WHERE team_id = $1 AND is_active = true
           ORDER BY created_at DESC`,
          [teamId]
        )
      : await query(
          `SELECT id, platform, account_id, account_username, account_display_name, profile_image_url, followers_count
           FROM social_connected_accounts
           WHERE user_id = $1 AND team_id IS NULL AND is_active = true
           ORDER BY created_at DESC`,
          [userId]
        );

    const postsResult = isTeamMember && teamId
      ? await query(
          `SELECT *
           FROM social_posts
           WHERE team_id = $1
             AND status <> 'deleted'
           ORDER BY COALESCE(posted_at, scheduled_for, created_at) DESC
           LIMIT 8`,
          [teamId]
        )
      : await query(
          `SELECT *
           FROM social_posts
           WHERE user_id = $1 AND team_id IS NULL
             AND status <> 'deleted'
           ORDER BY COALESCE(posted_at, scheduled_for, created_at) DESC
           LIMIT 8`,
          [userId]
        );

    const summaryResult = isTeamMember && teamId
      ? await query(
          `SELECT
             COALESCE(SUM(instagram_likes), 0) + COALESCE(SUM(threads_likes), 0) AS likes,
             COALESCE(SUM(youtube_views), 0) + COALESCE(SUM(threads_views), 0) AS views,
             COUNT(*) FILTER (WHERE status <> 'deleted')::bigint AS total_posts
           FROM social_posts
           WHERE team_id = $1
             AND status <> 'deleted'`,
          [teamId]
        )
      : await query(
          `SELECT
             COALESCE(SUM(instagram_likes), 0) + COALESCE(SUM(threads_likes), 0) AS likes,
             COALESCE(SUM(youtube_views), 0) + COALESCE(SUM(threads_views), 0) AS views,
             COUNT(*) FILTER (WHERE status <> 'deleted')::bigint AS total_posts
           FROM social_posts
           WHERE user_id = $1 AND team_id IS NULL
             AND status <> 'deleted'`,
          [userId]
        );

    const followers = accountResult.rows.reduce((sum, account) => {
      const value = Number.parseInt(account.followers_count || '0', 10);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);

    const summary = summaryResult.rows[0] || { likes: 0, views: 0, total_posts: 0 };
    let creditSnapshot = null;

    try {
      creditSnapshot = await TeamCreditService.getCredits(userId, isTeamMember ? teamId : null, userToken);
    } catch {
      try {
        const fallbackBalance = await creditService.getBalance(userId, null);
        creditSnapshot = { credits: fallbackBalance, source: 'user' };
      } catch {
        // Keep null when both team and personal credit lookups fail.
      }
    }

    return res.json({
      success: true,
      accounts: accountResult.rows,
      recentPosts: postsResult.rows,
      quickStats: {
        likes: Number.parseInt(summary.likes || '0', 10),
        views: Number.parseInt(summary.views || '0', 10),
        followers,
        totalPosts: Number.parseInt(summary.total_posts || '0', 10),
      },
      credits: creditSnapshot
        ? {
            balance: Number.parseFloat(creditSnapshot.credits || 0),
            creditsRemaining: Number.parseFloat(creditSnapshot.credits || 0),
            source: creditSnapshot.source || (isTeamMember && teamId ? 'team' : 'user'),
            scope: creditSnapshot.source === 'team' ? 'team' : 'personal',
          }
        : null,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch dashboard data', details: error.message });
  }
};
