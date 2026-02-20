import { generateCaption } from '../services/aiService.js';
import { TeamCreditService } from '../services/teamCreditService.js';

const resolveUserToken = (req) => {
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return req.platformAccessToken || bearerToken || req.cookies?.accessToken || null;
};

const resolveTeamId = (req) => {
  const { teamId, isTeamMember } = req.teamContext || {};
  return isTeamMember && teamId ? teamId : null;
};

export const generateAICaption = async (req, res) => {
  try {
    const { prompt, platforms = [], style = 'casual' } = req.body || {};

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const allowedStyles = ['casual', 'professional', 'witty', 'humorous', 'inspirational', 'informative'];
    if (!allowedStyles.includes(style)) {
      return res.status(400).json({ error: 'Invalid style' });
    }

    const userId = req.user?.id || null;
    const userToken = resolveUserToken(req);
    const teamId = resolveTeamId(req);

    const operation = 'social_ai_caption_generation';
    const creditCost = TeamCreditService.calculateCost(operation, {
      platformCount: Array.isArray(platforms) ? platforms.length : 1,
    });

    let creditMeta = {
      creditsUsed: 0,
      creditSource: teamId ? 'team' : 'user',
      creditsRemaining: null,
    };

    let creditsDeducted = false;
    if (creditCost > 0) {
      const creditCheck = await TeamCreditService.checkCredits(userId, teamId, creditCost, userToken);
      if (!creditCheck.success) {
        return res.status(402).json({
          error: 'Insufficient credits',
          creditsRequired: creditCost,
          creditsAvailable: creditCheck.available ?? creditCheck.creditsAvailable ?? 0,
          creditSource: creditCheck.source || (teamId ? 'team' : 'user'),
        });
      }

      const deductResult = await TeamCreditService.deductCredits(
        userId,
        teamId,
        creditCost,
        operation,
        userToken,
        {
          description: `AI caption generation (${style})`,
        }
      );

      if (!deductResult.success) {
        return res.status(402).json({
          error: deductResult.error || 'Failed to deduct credits',
          creditsRequired: creditCost,
          creditsAvailable: deductResult.available ?? deductResult.creditsAvailable ?? 0,
          creditSource: deductResult.source || (teamId ? 'team' : 'user'),
        });
      }

      creditsDeducted = true;
      creditMeta = {
        creditsUsed: creditCost,
        creditSource: deductResult.source || (teamId ? 'team' : 'user'),
        creditsRemaining: deductResult.remainingCredits ?? null,
      };
    }

    let result;
    try {
      result = await generateCaption({
        prompt: String(prompt).trim(),
        platforms: Array.isArray(platforms) ? platforms : [],
        style,
        userToken,
        userId,
      });
    } catch (error) {
      if (creditsDeducted) {
        await TeamCreditService.refundCredits(
          userId,
          teamId,
          creditCost,
          'social_ai_caption_generation_failed',
          userToken,
          {
            description: 'Refund for failed AI caption generation',
          }
        ).catch(() => null);
      }
      throw error;
    }

    return res.json({
      success: true,
      caption: result.caption,
      provider: result.provider,
      keyType: result.keyType,
      mode: result.mode,
      creditsUsed: creditMeta.creditsUsed,
      creditSource: creditMeta.creditSource,
      creditsRemaining: creditMeta.creditsRemaining,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to generate caption', details: error.message });
  }
};
