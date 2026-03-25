import express from 'express';
import { generateCaption } from '../services/aiService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

const ensureInternalRequest = (req, res, next) => {
  const configuredKey = String(process.env.INTERNAL_API_KEY || '').trim();
  const providedKey = String(req.headers['x-internal-api-key'] || '').trim();

  if (!configuredKey) {
    return res.status(503).json({
      error: 'Internal API key is not configured',
      code: 'INTERNAL_API_KEY_NOT_CONFIGURED',
    });
  }

  if (!providedKey || providedKey !== configuredKey) {
    return res.status(403).json({
      error: 'Forbidden',
      code: 'INTERNAL_AUTH_FAILED',
    });
  }

  req.isInternal = true;
  return next();
};

router.post('/caption', ensureInternalRequest, async (req, res) => {
  const platformUserId = String(req.headers['x-platform-user-id'] || '').trim();
  const { prompt, style = 'professional', platforms = [], workspaceName = '', brandName = '' } = req.body || {};

  if (!platformUserId) {
    return res.status(400).json({
      error: 'Platform user ID is required',
      code: 'PLATFORM_USER_ID_REQUIRED',
    });
  }

  const normalizedPrompt = String(prompt || '').trim();
  if (normalizedPrompt.length < 5) {
    return res.status(400).json({
      error: 'Prompt must be at least 5 characters long',
      code: 'SOCIAL_GENERATE_PROMPT_REQUIRED',
    });
  }

  try {
    const fullPrompt = [
      brandName ? `Brand: ${brandName}` : null,
      workspaceName ? `Workspace: ${workspaceName}` : null,
      normalizedPrompt,
    ].filter(Boolean).join('\n');

    const result = await generateCaption({
      prompt: fullPrompt,
      platforms: Array.isArray(platforms) ? platforms : [],
      style: String(style || 'professional').trim() || 'professional',
      userToken: null,
      userId: platformUserId,
    });

    return res.json({
      success: true,
      caption: result?.caption || '',
      provider: result?.provider || null,
      keyType: result?.keyType || null,
      mode: result?.mode || 'single',
    });
  } catch (error) {
    logger.error('[internal/ai/caption] Failed to generate social workspace draft', {
      userId: platformUserId,
      error: error?.message || String(error),
    });
    return res.status(500).json({
      error: 'Failed to generate social draft',
      code: 'SOCIAL_GENERATE_FAILED',
    });
  }
});

export default router;
