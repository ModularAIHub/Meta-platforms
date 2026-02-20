import { query } from '../config/database.js';

const normalizeMembership = (row) => ({
  teamId: row.team_id,
  role: row.role || 'viewer',
  status: row.status || 'active',
});

export const getMembershipsFromTokenPayload = (user) => {
  const memberships = Array.isArray(user?.teamMemberships) ? user.teamMemberships : [];
  return memberships
    .filter((membership) => membership?.teamId || membership?.team_id)
    .map((membership) => ({
      teamId: membership.teamId || membership.team_id,
      role: membership.role || 'viewer',
      status: membership.status || 'active',
    }));
};

export const getActiveMembershipFromDatabase = async (userId, preferredTeamId = null) => {
  if (!userId) {
    return null;
  }

  if (preferredTeamId) {
    let preferredResult;
    try {
      preferredResult = await query(
        `SELECT team_id, role, status
         FROM team_members
         WHERE user_id = $1 AND team_id = $2 AND status = 'active'
         LIMIT 1`,
        [userId, preferredTeamId]
      );
    } catch {
      return null;
    }

    if (preferredResult.rows[0]) {
      return normalizeMembership(preferredResult.rows[0]);
    }
  }

  let result;
  try {
    result = await query(
      `SELECT team_id, role, status
       FROM team_members
       WHERE user_id = $1 AND status = 'active'
       ORDER BY invited_at ASC
       LIMIT 1`,
      [userId]
    );
  } catch {
    return null;
  }

  if (!result.rows[0]) {
    return null;
  }

  return normalizeMembership(result.rows[0]);
};

export const resolveTeamContext = async (req) => {
  const userId = req.user?.id;
  const requestedTeamId = req.headers['x-team-id'] || req.user?.teamId || null;

  const payloadMemberships = getMembershipsFromTokenPayload(req.user);

  let activeMembership = null;

  if (requestedTeamId) {
    activeMembership = payloadMemberships.find(
      (membership) => String(membership.teamId) === String(requestedTeamId) && membership.status === 'active'
    );
  }

  if (!activeMembership) {
    activeMembership = payloadMemberships.find((membership) => membership.status === 'active') || null;
  }

  if (!activeMembership) {
    activeMembership = await getActiveMembershipFromDatabase(userId, requestedTeamId);
  }

  if (!activeMembership) {
    return {
      teamId: null,
      role: 'viewer',
      isTeamMember: false,
    };
  }

  return {
    teamId: activeMembership.teamId,
    role: activeMembership.role,
    isTeamMember: true,
  };
};
