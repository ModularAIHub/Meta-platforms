import express from 'express';
import { getAnalyticsOverview } from '../controllers/analyticsController.js';

const router = express.Router();

router.get('/overview', getAnalyticsOverview);

export default router;
