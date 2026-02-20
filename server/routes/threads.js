import express from 'express';
import { connectThreads, threadsCallback } from '../controllers/oauthController.js';
import { requirePlatformLogin } from '../middleware/requirePlatformLogin.js';
import { resolveTeamContextMiddleware } from '../middleware/resolveTeamContext.js';
import { requireConnectionManager } from '../middleware/requireConnectionManager.js';

const router = express.Router();

router.get('/auth', requirePlatformLogin, resolveTeamContextMiddleware, requireConnectionManager, connectThreads);
router.get('/callback', threadsCallback);

export default router;
