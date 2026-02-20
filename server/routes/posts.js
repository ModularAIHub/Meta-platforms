import express from 'express';
import {
  createPost,
  preflightPost,
  listRecentPosts,
  listHistoryPosts,
  deleteHistoryPost,
} from '../controllers/postsController.js';

const router = express.Router();

router.post('/preflight', preflightPost);
router.post('/', createPost);
router.get('/recent', listRecentPosts);
router.get('/history', listHistoryPosts);
router.delete('/:postId', deleteHistoryPost);

export default router;
