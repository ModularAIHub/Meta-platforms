import express from 'express';
import { cleanupController } from '../controllers/cleanupController.js';

const router = express.Router();

router.post('/user', cleanupController.cleanupUserData);
router.post('/team', cleanupController.cleanupTeamData);
router.post('/member', cleanupController.cleanupMemberData);

export default router;
