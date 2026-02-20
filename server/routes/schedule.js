import express from 'express';
import {
  listScheduledPosts,
  reschedulePost,
  retryPost,
  cancelScheduledPost,
} from '../controllers/scheduleController.js';

const router = express.Router();

router.get('/', listScheduledPosts);
router.patch('/:postId/reschedule', reschedulePost);
router.post('/:postId/retry', retryPost);
router.delete('/:postId', cancelScheduledPost);

export default router;
