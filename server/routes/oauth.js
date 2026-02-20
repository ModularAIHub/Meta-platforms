import express from 'express';
import {
  connectInstagram,
  instagramCallback,
  connectThreads,
  threadsCallback,
  connectYoutube,
  youtubeCallback,
} from '../controllers/oauthController.js';
import { requirePlatformLogin } from '../middleware/requirePlatformLogin.js';
import { resolveTeamContextMiddleware } from '../middleware/resolveTeamContext.js';
import { requireConnectionManager } from '../middleware/requireConnectionManager.js';

const router = express.Router();

router.get('/instagram/connect', requirePlatformLogin, resolveTeamContextMiddleware, requireConnectionManager, connectInstagram);
router.get('/threads/connect', requirePlatformLogin, resolveTeamContextMiddleware, requireConnectionManager, connectThreads);
router.get('/youtube/connect', requirePlatformLogin, resolveTeamContextMiddleware, requireConnectionManager, connectYoutube);

router.get('/instagram/callback', instagramCallback);
router.get('/threads/callback', threadsCallback);
router.get('/t', threadsCallback);
router.get('/youtube/callback', youtubeCallback);

export default router;
