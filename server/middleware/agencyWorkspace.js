import jwt from 'jsonwebtoken';

const EXPECTED_AUDIENCE = 'social-genie';

const normalizeStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
};

const parseAudiences = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  const single = String(value || '').trim();
  return single ? [single] : [];
};

export const applyAgencyWorkspaceContext = (req, res, next) => {
  const rawToken = String(req.headers['x-agency-token'] || req.query.agency_token || '').trim();
  if (!rawToken) {
    req.agencyWorkspace = null;
    return next();
  }

  try {
    const decoded = jwt.verify(rawToken, process.env.JWT_SECRET || 'development-secret');
    const audiences = parseAudiences(decoded?.aud);
    if (!audiences.includes(EXPECTED_AUDIENCE)) {
      return res.status(403).json({
        error: 'Agency workspace token is not valid for Social Genie',
        code: 'AGENCY_WORKSPACE_AUDIENCE_MISMATCH',
      });
    }

    const tokenWorkspaceId = String(decoded?.workspaceId || '').trim();
    const requestedWorkspaceId = String(
      req.headers['x-agency-workspace-id'] || req.query.workspace_id || tokenWorkspaceId
    ).trim();

    if (!tokenWorkspaceId || !requestedWorkspaceId || tokenWorkspaceId !== requestedWorkspaceId) {
      return res.status(400).json({
        error: 'Agency workspace token does not match the requested workspace',
        code: 'AGENCY_WORKSPACE_ID_MISMATCH',
      });
    }

    if (req.user?.id && decoded?.userId && String(req.user.id) !== String(decoded.userId)) {
      return res.status(403).json({
        error: 'Agency workspace token does not belong to this user',
        code: 'AGENCY_WORKSPACE_USER_MISMATCH',
      });
    }

    req.agencyWorkspace = {
      agencyId: String(decoded?.agencyId || '').trim() || null,
      workspaceId: tokenWorkspaceId,
      userId: String(decoded?.userId || '').trim() || null,
      role: String(decoded?.role || '').trim() || null,
      tool: String(req.headers['x-agency-tool'] || req.query.tool || '').trim() || null,
      target: String(req.headers['x-agency-target'] || req.query.target || '').trim() || null,
      allowedAccountIds: normalizeStringArray(decoded?.allowedAccountIds),
      issuedAt: decoded?.iat || null,
      expiresAt: decoded?.exp || null,
    };

    return next();
  } catch {
    return res.status(401).json({
      error: 'Invalid agency workspace context',
      code: 'INVALID_AGENCY_WORKSPACE_TOKEN',
    });
  }
};
