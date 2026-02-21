import { query } from '../config/database.js';

const resolveContextParams = (req) => {
  const userId = req.user.id;
  const { teamId, isTeamMember } = req.teamContext || {};

  return {
    userId,
    teamId: isTeamMember ? teamId : null,
    isTeamMember: Boolean(isTeamMember),
  };
};

const buildOwnershipClause = ({ isTeamMember, teamId, userId, startIndex = 1 }) => {
  if (isTeamMember && teamId) {
    return {
      clause: `team_id = $${startIndex}`,
      params: [teamId],
    };
  }

  return {
    clause: `user_id = $${startIndex} AND team_id IS NULL`,
    params: [userId],
  };
};

const parseScheduleDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

export const listScheduledPosts = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = resolveContextParams(req);
    const status = String(req.query.status || 'active').toLowerCase();
    const allowed = new Set(['active', 'all', 'scheduled', 'failed', 'publishing']);
    const normalizedStatus = allowed.has(status) ? status : 'active';

    const { clause, params } = buildOwnershipClause({ isTeamMember, teamId, userId });
    const filters = [clause, `status <> 'deleted'`];
    const queryParams = [...params];

    if (normalizedStatus === 'active') {
      filters.push(`status IN ('scheduled', 'publishing')`);
    } else if (normalizedStatus !== 'all') {
      queryParams.push(normalizedStatus);
      filters.push(`status = $${queryParams.length}`);
    }

    const result = await query(
      `SELECT *
       FROM social_posts
       WHERE ${filters.join(' AND ')}
       ORDER BY COALESCE(scheduled_for, created_at) ASC`,
      queryParams
    );

    return res.json({ success: true, posts: result.rows });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch scheduled posts', details: error.message });
  }
};

export const reschedulePost = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = resolveContextParams(req);
    const postId = String(req.params.postId || '').trim();
    const scheduledForIso = parseScheduleDate(req.body?.scheduledFor || req.body?.scheduled_for);

    if (!postId) {
      return res.status(400).json({ error: 'postId is required', code: 'POST_ID_REQUIRED' });
    }

    if (!scheduledForIso) {
      return res.status(400).json({ error: 'scheduledFor is required', code: 'SCHEDULED_FOR_REQUIRED' });
    }

    const { clause, params } = buildOwnershipClause({ isTeamMember, teamId, userId, startIndex: 2 });
    const lookup = await query(
      `SELECT id, status
       FROM social_posts
       WHERE id = $1 AND ${clause}
       LIMIT 1`,
      [postId, ...params]
    );

    const found = lookup.rows[0];
    if (!found) {
      return res.status(404).json({ error: 'Post not found', code: 'POST_NOT_FOUND' });
    }

    if (found.status === 'posted' || found.status === 'deleted') {
      return res.status(400).json({ error: 'Only scheduled/failed posts can be rescheduled', code: 'POST_NOT_RESCHEDULABLE' });
    }

    const updated = await query(
      `UPDATE social_posts
       SET status = 'scheduled',
           scheduled_for = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [postId, scheduledForIso]
    );

    return res.json({ success: true, post: updated.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to reschedule post', details: error.message });
  }
};

export const retryPost = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = resolveContextParams(req);
    const postId = String(req.params.postId || '').trim();
    const requestedSchedule = parseScheduleDate(req.body?.scheduledFor || req.body?.scheduled_for);
    const scheduledForIso = requestedSchedule || new Date().toISOString();

    if (!postId) {
      return res.status(400).json({ error: 'postId is required', code: 'POST_ID_REQUIRED' });
    }

    const { clause, params } = buildOwnershipClause({ isTeamMember, teamId, userId, startIndex: 2 });
    const lookup = await query(
      `SELECT id, status
       FROM social_posts
       WHERE id = $1 AND ${clause}
       LIMIT 1`,
      [postId, ...params]
    );

    const found = lookup.rows[0];
    if (!found) {
      return res.status(404).json({ error: 'Post not found', code: 'POST_NOT_FOUND' });
    }

    if (found.status === 'posted' || found.status === 'deleted') {
      return res.status(400).json({ error: 'Only scheduled/failed posts can be retried', code: 'POST_NOT_RETRYABLE' });
    }

    const updated = await query(
      `UPDATE social_posts
       SET status = 'scheduled',
           scheduled_for = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [postId, scheduledForIso]
    );

    return res.json({ success: true, post: updated.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to retry post', details: error.message });
  }
};

export const cancelScheduledPost = async (req, res) => {
  try {
    const { userId, teamId, isTeamMember } = resolveContextParams(req);
    const postId = String(req.params.postId || '').trim();

    if (!postId) {
      return res.status(400).json({ error: 'postId is required', code: 'POST_ID_REQUIRED' });
    }

    const { clause, params } = buildOwnershipClause({ isTeamMember, teamId, userId, startIndex: 2 });
    const lookup = await query(
      `SELECT id, status
       FROM social_posts
       WHERE id = $1 AND ${clause}
       LIMIT 1`,
      [postId, ...params]
    );

    const found = lookup.rows[0];
    if (!found) {
      return res.status(404).json({ error: 'Post not found', code: 'POST_NOT_FOUND' });
    }

    if (found.status === 'posted' || found.status === 'deleted') {
      return res.status(400).json({ error: 'Only scheduled/failed posts can be cancelled', code: 'POST_NOT_CANCELLABLE' });
    }

    await query(
      `UPDATE social_posts
       SET status = 'deleted',
           updated_at = NOW()
       WHERE id = $1`,
      [postId]
    );

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to cancel post', details: error.message });
  }
};
