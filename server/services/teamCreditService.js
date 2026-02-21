import { v4 as uuidv4 } from 'uuid';
import pool from '../config/database.js';
import { creditService } from './creditService.js';

const TEAM_CREDITS_ENABLED = process.env.ENABLE_TEAM_CREDITS !== 'false';
const CREDIT_DEBUG = process.env.CREDIT_DEBUG === 'true';

const toNumber = (value, fallback = 0) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundCredits = (value) => Math.round(toNumber(value, 0) * 100) / 100;
const shouldUseTeamCredits = (teamId) => Boolean(TEAM_CREDITS_ENABLED && teamId);

const debugLog = (...args) => {
  if (CREDIT_DEBUG) {
    console.log('[SOCIAL TEAM CREDITS]', ...args);
  }
};

const insertTeamTransaction = async (client, { userId, teamId, type, creditsAmount, description }) => {
  const transactionId = uuidv4();
  const signedAmount = type === 'usage' ? -Math.abs(roundCredits(creditsAmount)) : Math.abs(roundCredits(creditsAmount));

  try {
    await client.query(
      `INSERT INTO credit_transactions (id, user_id, type, credits_amount, description, service_name, team_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'meta-genie', $6, CURRENT_TIMESTAMP)`,
      [transactionId, userId, type, signedAmount, description, teamId]
    );
  } catch (error) {
    if (error?.code !== '42703') {
      throw error;
    }

    await client.query(
      `INSERT INTO credit_transactions (id, user_id, type, credits_amount, description, service_name, created_at)
       VALUES ($1, $2, $3, $4, $5, 'meta-genie', CURRENT_TIMESTAMP)`,
      [transactionId, userId, type, signedAmount, `[team:${teamId}] ${description}`]
    );
  }

  return transactionId;
};

export const TeamCreditService = {
  calculateCost(operation, metadata = {}) {
    return creditService.calculateCost(operation, metadata);
  },

  getCreditCosts() {
    return creditService.getCreditCosts();
  },

  async getCredits(userId, teamId = null, userToken = null) {
    try {
      if (shouldUseTeamCredits(teamId)) {
        const result = await pool.query('SELECT credits_remaining FROM teams WHERE id = $1', [teamId]);

        if (result.rows.length > 0) {
          const credits = roundCredits(result.rows[0].credits_remaining || 0);
          return { credits, source: 'team' };
        }

        // Team context was provided but team credits row is unavailable.
        // Fall back to personal credits so module UX remains functional.
        debugLog('Team credits row not found, falling back to personal credits', { userId, teamId });
      }

      const credits = await creditService.getBalance(userId, userToken);
      return { credits: roundCredits(credits), source: 'user' };
    } catch (error) {
      debugLog('Get credits failed', error?.message || error);

      // Last-chance fallback to direct personal balance.
      // This mirrors the behavior users expect from other modules.
      try {
        const credits = await creditService.getBalance(userId, null);
        return { credits: roundCredits(credits), source: 'user' };
      } catch (fallbackError) {
        debugLog('Fallback personal credit lookup failed', fallbackError?.message || fallbackError);
        throw error;
      }
    }
  },

  async checkCredits(userId, teamId, amount, userToken = null) {
    try {
      const roundedAmount = roundCredits(amount);
      if (roundedAmount <= 0) {
        return {
          success: true,
          available: await this.getCredits(userId, teamId, userToken).then((data) => data.credits),
          source: shouldUseTeamCredits(teamId) ? 'team' : 'user',
        };
      }

      const { credits, source } = await this.getCredits(userId, teamId, userToken);
      return {
        success: credits >= roundedAmount,
        available: credits,
        creditsAvailable: credits,
        required: roundedAmount,
        creditsRequired: roundedAmount,
        source,
      };
    } catch {
      return {
        success: false,
        available: 0,
        creditsAvailable: 0,
        required: roundCredits(amount),
        creditsRequired: roundCredits(amount),
        source: shouldUseTeamCredits(teamId) ? 'team' : 'user',
      };
    }
  },

  async deductCredits(userId, teamId, amount, operation, userToken = null, options = {}) {
    const roundedAmount = roundCredits(amount);
    const description = options.description || `${operation} - ${roundedAmount} credits deducted`;

    if (roundedAmount <= 0) {
      const { credits, source } = await this.getCredits(userId, teamId, userToken);
      return {
        success: true,
        creditsDeducted: 0,
        remainingCredits: credits,
        source,
      };
    }

    if (!shouldUseTeamCredits(teamId)) {
      const result = await creditService.checkAndDeductCredits(
        userId,
        operation,
        roundedAmount,
        userToken,
        { description }
      );

      return {
        ...result,
        source: 'user',
      };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const teamResult = await client.query(
        'SELECT credits_remaining FROM teams WHERE id = $1 FOR UPDATE',
        [teamId]
      );

      if (teamResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'team_not_found',
          source: 'team',
          remainingCredits: 0,
        };
      }

      const currentTeamCredits = roundCredits(teamResult.rows[0].credits_remaining || 0);
      if (currentTeamCredits < roundedAmount) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'insufficient_credits',
          source: 'team',
          remainingCredits: currentTeamCredits,
          available: currentTeamCredits,
          creditsAvailable: currentTeamCredits,
          required: roundedAmount,
          creditsRequired: roundedAmount,
        };
      }

      const newBalance = roundCredits(currentTeamCredits - roundedAmount);
      await client.query('UPDATE teams SET credits_remaining = $1 WHERE id = $2', [newBalance, teamId]);

      const transactionId = await insertTeamTransaction(client, {
        userId,
        teamId,
        type: 'usage',
        creditsAmount: roundedAmount,
        description,
      });

      await client.query('COMMIT');
      debugLog('Team credits deducted', { teamId, userId, roundedAmount, newBalance });

      return {
        success: true,
        transactionId,
        source: 'team',
        creditsDeducted: roundedAmount,
        remainingCredits: newBalance,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      debugLog('Team credit deduction failed', error?.message || error);
      return {
        success: false,
        error: error?.message || 'team_credit_deduction_failed',
        source: 'team',
        remainingCredits: 0,
      };
    } finally {
      client.release();
    }
  },

  async refundCredits(userId, teamId, amount, reason, userToken = null, options = {}) {
    const roundedAmount = roundCredits(amount);
    const description = options.description || `${reason} - ${roundedAmount} credits refunded`;

    if (roundedAmount <= 0) {
      return { success: true, refundedAmount: 0 };
    }

    if (!shouldUseTeamCredits(teamId)) {
      const result = await creditService.refundCredits(userId, reason, roundedAmount, userToken, {
        description,
      });

      return {
        ...result,
        source: 'user',
      };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const teamResult = await client.query(
        'SELECT credits_remaining FROM teams WHERE id = $1 FOR UPDATE',
        [teamId]
      );

      if (teamResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'team_not_found',
          source: 'team',
        };
      }

      const currentTeamCredits = roundCredits(teamResult.rows[0].credits_remaining || 0);
      const newBalance = roundCredits(currentTeamCredits + roundedAmount);

      await client.query('UPDATE teams SET credits_remaining = $1 WHERE id = $2', [newBalance, teamId]);

      const transactionId = await insertTeamTransaction(client, {
        userId,
        teamId,
        type: 'refund',
        creditsAmount: roundedAmount,
        description,
      });

      await client.query('COMMIT');
      debugLog('Team credits refunded', { teamId, userId, roundedAmount, newBalance });

      return {
        success: true,
        transactionId,
        source: 'team',
        refundedAmount: roundedAmount,
        newBalance,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      debugLog('Team credit refund failed', error?.message || error);
      return {
        success: false,
        error: error?.message || 'team_credit_refund_failed',
        source: 'team',
      };
    } finally {
      client.release();
    }
  },
};
