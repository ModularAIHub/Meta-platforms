import { resolveTeamContext } from '../services/teamContextService.js';

export const resolveTeamContextMiddleware = async (req, res, next) => {
  try {
    req.teamContext = await resolveTeamContext(req);
    return next();
  } catch (error) {
    return res.status(500).json({ error: 'Failed to resolve team context', details: error.message });
  }
};
