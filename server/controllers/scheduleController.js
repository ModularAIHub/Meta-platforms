import { query } from '../config/database.js';

const EXTERNAL_CROSS_SCHEDULE_FETCH_LIMIT = 100;

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

const parseJsonObject = (value, fallback = {}) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...fallback, ...value };
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...fallback, ...parsed };
      }
    } catch {
      return { ...fallback };
    }
  }
  return { ...fallback };
};

const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const mapTweetGenieThreadsCrossScheduleStatus = (row) => {
  const sourceStatus = String(row?.status || '').toLowerCase();
  const metadata = parseJsonObject(row?.metadata, {});
  const threadsResultStatus = String(
    metadata?.cross_post?.last_result?.threads?.status || ''
  ).toLowerCase();

  if (sourceStatus === 'cancelled') return 'deleted';
  if (sourceStatus === 'failed') return 'failed';
  if (sourceStatus === 'processing') return 'publishing';
  if (sourceStatus === 'pending') return 'scheduled';

  if (sourceStatus === 'completed' || sourceStatus === 'partially_completed') {
    if (!threadsResultStatus) {
      return 'posted';
    }

    if (threadsResultStatus === 'posted') return 'posted';
    if (
      [
        'failed',
        'timeout',
        'not_connected',
        'skipped_not_configured',
        'skipped_source_thread_failed',
      ].includes(threadsResultStatus)
    ) {
      return 'failed';
    }
    return 'posted';
  }

  return 'scheduled';
};

const buildExternalThreadsScheduledRow = (row) => {
  const metadata = parseJsonObject(row?.metadata, {});
  const crossPostMeta =
    metadata?.cross_post && typeof metadata.cross_post === 'object' ? metadata.cross_post : {};
  const threadsLastResult =
    crossPostMeta?.last_result?.threads &&
    typeof crossPostMeta.last_result.threads === 'object'
      ? crossPostMeta.last_result.threads
      : null;
  const threadParts = parseJsonArray(row?.thread_tweets);
  const mappedStatus = mapTweetGenieThreadsCrossScheduleStatus(row);

  return {
    id: `tgx-${row.id}`,
    user_id: row.user_id,
    team_id: row.team_id || null,
    caption: row.content || '',
    media_urls: JSON.stringify([]),
    platforms: ['threads'],
    cross_post: true,
    threads_content_type: threadParts.length > 0 ? 'thread' : 'text',
    status: mappedStatus,
    scheduled_for: row.scheduled_for,
    timezone: row.timezone || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    posted_at: row.posted_at || null,
    error_message:
      row.error_message ||
      (threadsLastResult?.status && threadsLastResult.status !== 'posted'
        ? `Tweet Genie cross-post status: ${threadsLastResult.status}`
        : null),
    is_external_cross_post: true,
    external_source: 'tweet-genie',
    external_ref_id: row.id,
    external_target: 'threads',
    external_read_only: true,
    external_meta: {
      source_status: row.status || null,
      threads_status: threadsLastResult?.status || null,
      last_attempted_at: crossPostMeta?.last_attempted_at || null,
    },
  };
};

const mapLinkedInThreadsCrossScheduleStatus = (row) => {
  const sourceStatus = String(row?.status || '').toLowerCase();
  const metadata = parseJsonObject(row?.metadata, {});
  const threadsResultStatus = String(
    metadata?.cross_post?.last_result?.threads?.status || ''
  ).toLowerCase();

  if (sourceStatus === 'cancelled' || sourceStatus === 'canceled') return 'deleted';
  if (sourceStatus === 'failed') return 'failed';
  if (sourceStatus === 'processing') return 'publishing';
  if (sourceStatus === 'scheduled') return 'scheduled';

  if (sourceStatus === 'completed') {
    if (!threadsResultStatus) return 'posted';
    if (threadsResultStatus === 'posted') return 'posted';
    if (
      [
        'failed',
        'timeout',
        'not_connected',
        'skipped_not_configured',
        'skipped_individual_only',
      ].includes(threadsResultStatus)
    ) {
      return 'failed';
    }
    return 'posted';
  }

  return 'scheduled';
};

const buildExternalThreadsScheduledRowFromLinkedIn = (row) => {
  const metadata = parseJsonObject(row?.metadata, {});
  const crossPostMeta =
    metadata?.cross_post && typeof metadata.cross_post === 'object' ? metadata.cross_post : {};
  const threadsLastResult =
    crossPostMeta?.last_result?.threads &&
    typeof crossPostMeta.last_result.threads === 'object'
      ? crossPostMeta.last_result.threads
      : null;
  const mappedStatus = mapLinkedInThreadsCrossScheduleStatus(row);

  return {
    id: `lgx-${row.id}`,
    user_id: row.user_id,
    team_id: row.company_id || null,
    caption: row.post_content || '',
    media_urls: row.media_urls || JSON.stringify([]),
    platforms: ['threads'],
    cross_post: true,
    threads_content_type: 'text',
    status: mappedStatus,
    scheduled_for: row.scheduled_time,
    timezone: row.timezone || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    posted_at: row.posted_at || null,
    error_message:
      row.error_message ||
      (threadsLastResult?.status && threadsLastResult.status !== 'posted'
        ? `LinkedIn cross-post to Threads status: ${threadsLastResult.status}`
        : null),
    is_external_cross_post: true,
    external_source: 'linkedin-genie',
    external_ref_id: row.id,
    external_target: 'threads',
    external_read_only: true,
    external_meta: {
      source_status: row.status || null,
      threads_status: threadsLastResult?.status || null,
      last_attempted_at: crossPostMeta?.last_attempted_at || null,
    },
  };
};

const matchesScheduleStatusFilter = (status, filter) => {
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus === 'deleted') return false;
  if (filter === 'all') return true;
  if (filter === 'active') return normalizedStatus === 'scheduled' || normalizedStatus === 'publishing';
  return normalizedStatus === filter;
};

const fetchExternalTweetGenieThreadsCrossSchedules = async ({ userId, teamId = null, isTeamMember = false, statusFilter = 'active', limit = EXTERNAL_CROSS_SCHEDULE_FETCH_LIMIT }) => {
  const safeLimit = Math.max(1, Math.min(EXTERNAL_CROSS_SCHEDULE_FETCH_LIMIT, Number(limit) || EXTERNAL_CROSS_SCHEDULE_FETCH_LIMIT));
  const ownerClause = isTeamMember && teamId
    ? `team_id::text = $1`
    : `user_id = $1 AND team_id IS NULL`;
  const ownerParam = isTeamMember && teamId ? String(teamId) : userId;

  const result = await query(
    `SELECT id, user_id, team_id, content, thread_tweets, scheduled_for, timezone, status, error_message, metadata, created_at, updated_at, posted_at
     FROM scheduled_tweets
     WHERE ${ownerClause}
       AND metadata->'cross_post'->'targets'->>'threads' = 'true'
     ORDER BY scheduled_for DESC
     LIMIT $2`,
    [ownerParam, safeLimit]
  );

  return result.rows
    .map(buildExternalThreadsScheduledRow)
    .filter((row) => matchesScheduleStatusFilter(row.status, statusFilter));
};

const fetchExternalLinkedInThreadsCrossSchedules = async ({ userId, teamId = null, isTeamMember = false, statusFilter = 'active', limit = EXTERNAL_CROSS_SCHEDULE_FETCH_LIMIT }) => {
  const safeLimit = Math.max(1, Math.min(EXTERNAL_CROSS_SCHEDULE_FETCH_LIMIT, Number(limit) || EXTERNAL_CROSS_SCHEDULE_FETCH_LIMIT));
  const ownerClause = isTeamMember && teamId
    ? `company_id::text = $1`
    : `user_id = $1 AND (company_id IS NULL OR company_id::text = '')`;
  const ownerParam = isTeamMember && teamId ? String(teamId) : userId;

  const result = await query(
    `SELECT *
     FROM scheduled_linkedin_posts
     WHERE ${ownerClause}
     ORDER BY scheduled_time DESC
     LIMIT $2`,
    [ownerParam, safeLimit]
  );

  return result.rows
    .filter((row) => {
      const metadata = parseJsonObject(row?.metadata, {});
      return Boolean(metadata?.cross_post?.targets?.threads);
    })
    .map(buildExternalThreadsScheduledRowFromLinkedIn)
    .filter((row) => matchesScheduleStatusFilter(row.status, statusFilter));
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

    let externalPosts = [];
    try {
      const [tweetGenieExternalPosts, linkedInExternalPosts] = await Promise.all([
        fetchExternalTweetGenieThreadsCrossSchedules({
          userId,
          teamId,
          isTeamMember,
          statusFilter: normalizedStatus,
          limit: EXTERNAL_CROSS_SCHEDULE_FETCH_LIMIT,
        }),
        fetchExternalLinkedInThreadsCrossSchedules({
          userId,
          teamId,
          isTeamMember,
          statusFilter: normalizedStatus,
          limit: EXTERNAL_CROSS_SCHEDULE_FETCH_LIMIT,
        }),
      ]);
      externalPosts = [...tweetGenieExternalPosts, ...linkedInExternalPosts];
    } catch {
      externalPosts = [];
    }

    const posts = [...result.rows, ...externalPosts].sort((a, b) => {
      const aTime = new Date(a?.scheduled_for || a?.created_at || 0).getTime();
      const bTime = new Date(b?.scheduled_for || b?.created_at || 0).getTime();
      return aTime - bTime;
    });

    return res.json({ success: true, posts });
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
