import express from 'express';
import { TeamCreditService } from '../services/teamCreditService.js';
import { creditService } from '../services/creditService.js';

const router = express.Router();

const resolveRequestToken = (req) => {
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return req.platformAccessToken || bearerToken || req.cookies?.accessToken || null;
};

const resolveTeamId = (req) => {
  const context = req.teamContext || {};
  return context.isTeamMember && context.teamId ? context.teamId : null;
};

router.get('/balance', async (req, res) => {
  try {
    const userId = req.user.id;
    const teamId = resolveTeamId(req);
    const userToken = resolveRequestToken(req);

    const { credits, source } = await TeamCreditService.getCredits(userId, teamId, userToken);
    const balance = Number.parseFloat(credits || 0);

    return res.json({
      balance,
      creditsRemaining: balance,
      source,
      scope: source === 'team' ? 'team' : 'personal',
      teamId: source === 'team' ? teamId : null,
    });
  } catch (error) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(500).json({ error: 'Failed to fetch credit balance', details: error.message });
      }

      const fallbackBalance = await creditService.getBalance(userId, null);
      const balance = Number.parseFloat(fallbackBalance || 0);

      return res.json({
        balance,
        creditsRemaining: balance,
        source: 'user',
        scope: 'personal',
        teamId: null,
        fallback: true,
      });
    } catch (fallbackError) {
      return res
        .status(500)
        .json({ error: 'Failed to fetch credit balance', details: fallbackError.message || error.message });
    }
  }
});

router.get('/history', async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, type } = req.query;

    const history = await creditService.getUsageHistory(userId, {
      page: Number.parseInt(page, 10),
      limit: Number.parseInt(limit, 10),
      type: type || undefined,
    });

    return res.json(history);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch credit history', details: error.message });
  }
});

router.get('/pricing', (_req, res) => {
  try {
    return res.json({
      pricing: TeamCreditService.getCreditCosts(),
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch pricing information', details: error.message });
  }
});

router.post('/refund', async (req, res) => {
  try {
    const userId = req.user.id;
    const teamId = resolveTeamId(req);
    const userToken = resolveRequestToken(req);

    const amount = Number.parseFloat(req.body?.amount);
    const reason = String(req.body?.reason || '').trim();

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid refund amount' });
    }

    if (!reason) {
      return res.status(400).json({ error: 'Refund reason is required' });
    }

    const result = await TeamCreditService.refundCredits(userId, teamId, amount, reason, userToken);
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to process refund' });
    }

    return res.json({
      success: true,
      refundedAmount: result.refundedAmount || amount,
      newBalance: result.newBalance ?? null,
      source: result.source || (teamId ? 'team' : 'user'),
      transactionId: result.transactionId || null,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to process refund', details: error.message });
  }
});

export default router;
