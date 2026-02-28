import { pool } from '../config/database.js';
import { logger } from '../utils/logger.js';

const tableExists = async (client, tableName) => {
  const { rows } = await client.query('SELECT to_regclass($1) AS table_name', [tableName]);
  return Boolean(rows[0]?.table_name);
};

const deleteFromTable = async (client, tableName, whereSql, params, label, counts, countKey) => {
  if (!(await tableExists(client, tableName))) {
    counts[countKey] = 0;
    return 0;
  }

  const result = await client.query(`DELETE FROM ${tableName} ${whereSql}`, params);
  const deleted = result.rowCount || 0;
  counts[countKey] = deleted;
  logger.info(`[Social Cleanup] Deleted ${deleted} ${label}`);
  return deleted;
};

export const cleanupController = {
  async cleanupUserData(req, res) {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({
          error: 'userId is required',
          code: 'MISSING_USER_ID',
        });
      }

      logger.info('[Social Cleanup] Starting full user cleanup', { userId });
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        const deletedCounts = {};

        await deleteFromTable(
          client,
          'social_posts',
          'WHERE user_id = $1',
          [userId],
          'social posts',
          deletedCounts,
          'posts'
        );

        await deleteFromTable(
          client,
          'social_connected_accounts',
          'WHERE user_id::text = $1::text',
          [userId],
          'social connected accounts',
          deletedCounts,
          'accounts'
        );

        await client.query('COMMIT');
        return res.json({
          success: true,
          message: 'Social Genie user data wiped successfully',
          deletedCounts,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('[Social Cleanup] User cleanup error', { message: error.message });
      return res.status(500).json({
        error: 'Failed to cleanup Social Genie data',
        code: 'CLEANUP_ERROR',
        message: error.message,
      });
    }
  },

  async cleanupTeamData(req, res) {
    try {
      const { teamId } = req.body;
      if (!teamId) {
        return res.status(400).json({
          error: 'teamId is required',
          code: 'MISSING_TEAM_ID',
        });
      }

      logger.info('[Social Cleanup] Starting full team cleanup', { teamId });
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        const deletedCounts = {};

        await deleteFromTable(
          client,
          'social_posts',
          'WHERE team_id::text = $1::text',
          [teamId],
          'team social posts',
          deletedCounts,
          'posts'
        );

        await deleteFromTable(
          client,
          'social_connected_accounts',
          'WHERE team_id::text = $1::text',
          [teamId],
          'team connected accounts',
          deletedCounts,
          'accounts'
        );

        await client.query('COMMIT');
        return res.json({
          success: true,
          message: 'Social Genie team data wiped successfully',
          deletedCounts,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('[Social Cleanup] Team cleanup error', { message: error.message });
      return res.status(500).json({
        error: 'Failed to cleanup Social Genie team data',
        code: 'CLEANUP_ERROR',
        message: error.message,
      });
    }
  },

  async cleanupMemberData(req, res) {
    try {
      const { teamId, userId } = req.body;
      if (!teamId || !userId) {
        return res.status(400).json({
          error: 'teamId and userId are required',
          code: 'MISSING_PARAMS',
        });
      }

      logger.info('[Social Cleanup] Starting member cleanup', { teamId, userId });
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        const deletedCounts = {};

        await deleteFromTable(
          client,
          'social_posts',
          'WHERE team_id::text = $1::text AND user_id::text = $2::text',
          [teamId, userId],
          'member social posts',
          deletedCounts,
          'posts'
        );

        await deleteFromTable(
          client,
          'social_connected_accounts',
          'WHERE team_id::text = $1::text AND user_id::text = $2::text',
          [teamId, userId],
          'member connected accounts',
          deletedCounts,
          'accounts'
        );

        await client.query('COMMIT');
        return res.json({
          success: true,
          message: 'Social Genie member data wiped successfully',
          deletedCounts,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('[Social Cleanup] Member cleanup error', { message: error.message });
      return res.status(500).json({
        error: 'Failed to cleanup Social Genie member data',
        code: 'CLEANUP_ERROR',
        message: error.message,
      });
    }
  },
};
