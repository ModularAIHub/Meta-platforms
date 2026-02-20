export const requireConnectionManager = (req, res, next) => {
  const context = req.teamContext || { isTeamMember: false, role: 'viewer' };

  // Personal mode (no team): user can manage their own connections.
  if (!context.isTeamMember || !context.teamId) {
    return next();
  }

  if (!['owner', 'admin'].includes(context.role)) {
    return res.status(403).json({
      error: 'Only team owner/admin can manage connected accounts',
      code: 'INSUFFICIENT_ROLE',
    });
  }

  return next();
};
