import express from 'express';
import {
  listAccounts,
  getAccountPermissions,
  disconnectAccount,
  connectInstagramByok,
} from '../controllers/accountsController.js';
import { requireConnectionManager } from '../middleware/requireConnectionManager.js';

const router = express.Router();

router.get('/', listAccounts);
router.get('/permissions', getAccountPermissions);
router.post('/instagram/byok-connect', requireConnectionManager, connectInstagramByok);
router.delete('/:accountId', requireConnectionManager, disconnectAccount);

export default router;
