import express from 'express';
import { generateAICaption } from '../controllers/aiController.js';

const router = express.Router();

router.post('/caption', generateAICaption);

export default router;
