import express from 'express';
import { uploadMedia, uploadMiddleware } from '../controllers/mediaController.js';

const router = express.Router();

router.post('/upload', uploadMiddleware.single('file'), uploadMedia);

export default router;
