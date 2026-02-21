import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../config/database.js';

const PLATFORM_CREDIT_API_BASE = process.env.NEW_PLATFORM_API_URL || 'http://localhost:3000/api';
const CREDIT_DEBUG = process.env.CREDIT_DEBUG === 'true';
const CREDIT_USE_PLATFORM_API = process.env.CREDIT_USE_PLATFORM_API === 'true';
const CREDIT_FALLBACK_TO_LOCAL_DB = process.env.CREDIT_FALLBACK_TO_LOCAL_DB !== 'false';

const toNumber = (value, fallback = 0) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundCredits = (value) => Math.round(toNumber(value, 0) * 100) / 100;

const CREDIT_COSTS = {
  social_ai_caption_generation: toNumber(process.env.CREDIT_COST_SOCIAL_AI_CAPTION, 1.2),
  social_post_create: toNumber(process.env.CREDIT_COST_SOCIAL_POST_CREATE, 0),
  social_post_schedule: toNumber(process.env.CREDIT_COST_SOCIAL_POST_SCHEDULE, 0),
  social_post_platform_extra: toNumber(process.env.CREDIT_COST_SOCIAL_POST_PLATFORM_EXTRA, 0),
  social_post_cross_post_extra: toNumber(process.env.CREDIT_COST_SOCIAL_POST_CROSS_POST_EXTRA, 0),
};

const buildHeaders = (token, teamId = null) => {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (teamId) {
    headers['x-team-id'] = String(teamId);
  }
  return headers;
};

const parseCreditsFromPayload = (payload) =>
  roundCredits(
    payload?.creditsRemaining ??
      payload?.credits_remaining ??
      payload?.balance ??
      payload?.remaining_balance ??
      0
  );

const parseInsufficientFromMessage = (message = '') => {
  const text = String(message || '');
  const requiredMatch = text.match(/required:\s*([0-9.]+)/i);
  const availableMatch = text.match(/available:\s*([0-9.]+)/i);

  return {
    required: requiredMatch ? roundCredits(requiredMatch[1]) : null,
    available: availableMatch ? roundCredits(availableMatch[1]) : null,
  };
};

class CreditService {
  debugLog(...args) {
    if (CREDIT_DEBUG) {
      console.log('[SOCIAL CREDITS]', ...args);
    }
  }

  getCreditCosts() {
    return { ...CREDIT_COSTS };
  }

  calculateCost(operation, metadata = {}) {
    if (operation === 'social_post_create' || operation === 'social_post_schedule') {
      const platformCount = Math.max(1, Number.parseInt(metadata.platformCount || '1', 10));
      const baseCost = CREDIT_COSTS[operation] || 0;
      const platformExtra = (platformCount - 1) * (CREDIT_COSTS.social_post_platform_extra || 0);
      const crossPostExtra = metadata.crossPost ? CREDIT_COSTS.social_post_cross_post_extra || 0 : 0;
      return roundCredits(baseCost + platformExtra + crossPostExtra);
    }

    return roundCredits(CREDIT_COSTS[operation] ?? 1);
  }

  async getBalance(userId, userToken = null, options = {}) {
    const { teamId = null } = options;

    if (CREDIT_USE_PLATFORM_API && userToken) {
      try {
        this.debugLog('Fetching balance from platform API', { userId, teamId });
        const response = await axios.get(`${PLATFORM_CREDIT_API_BASE}/credits/balance`, {
          headers: buildHeaders(userToken, teamId),
          timeout: 10000,
        });
        return parseCreditsFromPayload(response.data);
      } catch (error) {
        this.debugLog('Platform credit balance fetch failed', error?.message || error);
        if (!CREDIT_FALLBACK_TO_LOCAL_DB) {
          throw new Error('Failed to fetch credit balance from platform');
        }
      }
    }

    const result = await pool.query('SELECT credits_remaining FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return 0;
    }

    return roundCredits(result.rows[0].credits_remaining || 0);
  }

  async checkAndDeductCredits(userId, operation, amount, userToken = null, options = {}) {
    const roundedAmount = roundCredits(amount);
    const { teamId = null, description = '' } = options;

    if (roundedAmount <= 0) {
      return {
        success: true,
        creditsDeducted: 0,
        remainingCredits: await this.getBalance(userId, userToken, { teamId }),
      };
    }

    if (CREDIT_USE_PLATFORM_API && userToken) {
      try {
        this.debugLog('Deducting credits via platform API', {
          userId,
          operation,
          amount: roundedAmount,
          teamId,
        });
        const response = await axios.post(
          `${PLATFORM_CREDIT_API_BASE}/credits/deduct`,
          {
            operation,
            cost: roundedAmount,
            description: description || `${operation} - ${roundedAmount} credits`,
          },
          {
            headers: buildHeaders(userToken, teamId),
            timeout: 12000,
          }
        );

        return {
          success: true,
          creditsDeducted: roundCredits(response.data?.creditsDeducted ?? roundedAmount),
          remainingCredits: parseCreditsFromPayload(response.data),
          transactionId: response.data?.transactionId || null,
        };
      } catch (error) {
        const status = error?.response?.status;
        const payload = error?.response?.data || {};
        const message = payload?.error || payload?.message || error?.message || 'Credit deduction failed';

        if (status === 400 && /insufficient/i.test(message)) {
          const parsed = parseInsufficientFromMessage(message);
          const fallbackAvailable =
            parsed.available ??
            (await this.getBalance(userId, userToken, { teamId }).catch(() => 0));

          return {
            success: false,
            error: 'insufficient_credits',
            available: roundCredits(fallbackAvailable),
            creditsAvailable: roundCredits(fallbackAvailable),
            required: parsed.required ?? roundedAmount,
            creditsRequired: parsed.required ?? roundedAmount,
          };
        }

        this.debugLog('Platform credit deduction failed', message);
        if (!CREDIT_FALLBACK_TO_LOCAL_DB) {
          throw new Error(message);
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const balanceResult = await client.query(
        'SELECT credits_remaining FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );

      if (balanceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'user_not_found',
          available: 0,
          creditsAvailable: 0,
          required: roundedAmount,
          creditsRequired: roundedAmount,
        };
      }

      const currentBalance = roundCredits(balanceResult.rows[0].credits_remaining || 0);
      if (currentBalance < roundedAmount) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'insufficient_credits',
          available: currentBalance,
          creditsAvailable: currentBalance,
          required: roundedAmount,
          creditsRequired: roundedAmount,
        };
      }

      const newBalance = roundCredits(currentBalance - roundedAmount);

      await client.query(
        'UPDATE users SET credits_remaining = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newBalance, userId]
      );

      const transactionId = uuidv4();
      await client.query(
        `INSERT INTO credit_transactions (id, user_id, type, credits_amount, description, service_name, created_at)
         VALUES ($1, $2, 'usage', $3, $4, 'meta-genie', CURRENT_TIMESTAMP)`,
        [transactionId, userId, -roundedAmount, description || `${operation} - ${roundedAmount} credits deducted`]
      );

      await client.query('COMMIT');

      return {
        success: true,
        transactionId,
        creditsDeducted: roundedAmount,
        remainingCredits: newBalance,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async refundCredits(userId, operation, amount, userToken = null, options = {}) {
    const roundedAmount = roundCredits(amount);
    const { teamId = null, description = '' } = options;

    if (roundedAmount <= 0) {
      return {
        success: true,
        refundedAmount: 0,
        newBalance: await this.getBalance(userId, userToken, { teamId }),
      };
    }

    if (CREDIT_USE_PLATFORM_API && userToken) {
      try {
        this.debugLog('Refunding credits via platform API', {
          userId,
          operation,
          amount: roundedAmount,
          teamId,
        });
        const response = await axios.post(
          `${PLATFORM_CREDIT_API_BASE}/credits/add`,
          {
            amount: roundedAmount,
            description: description || `${operation} - ${roundedAmount} credits refunded`,
          },
          {
            headers: buildHeaders(userToken, teamId),
            timeout: 12000,
          }
        );

        return {
          success: true,
          refundedAmount: roundCredits(response.data?.creditsAdded ?? roundedAmount),
          newBalance: parseCreditsFromPayload(response.data),
          transactionId: response.data?.transactionId || null,
        };
      } catch (error) {
        this.debugLog('Platform credit refund failed', error?.message || error);
        if (!CREDIT_FALLBACK_TO_LOCAL_DB) {
          throw new Error('Failed to refund credits on platform');
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const balanceResult = await client.query(
        'SELECT credits_remaining FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );

      if (balanceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'user_not_found',
        };
      }

      const currentBalance = roundCredits(balanceResult.rows[0].credits_remaining || 0);
      const newBalance = roundCredits(currentBalance + roundedAmount);

      await client.query(
        'UPDATE users SET credits_remaining = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newBalance, userId]
      );

      const transactionId = uuidv4();
      await client.query(
        `INSERT INTO credit_transactions (id, user_id, type, credits_amount, description, service_name, created_at)
         VALUES ($1, $2, 'refund', $3, $4, 'meta-genie', CURRENT_TIMESTAMP)`,
        [transactionId, userId, roundedAmount, description || `${operation} - ${roundedAmount} credits refunded`]
      );

      await client.query('COMMIT');

      return {
        success: true,
        transactionId,
        refundedAmount: roundedAmount,
        newBalance,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getUsageHistory(userId, options = {}) {
    const page = Math.max(1, Number.parseInt(options.page || '1', 10));
    const limit = Math.max(1, Math.min(100, Number.parseInt(options.limit || '20', 10)));
    const type = options.type ? String(options.type) : null;

    const filters = ['user_id = $1'];
    const params = [userId];

    if (type) {
      params.push(type);
      filters.push(`type = $${params.length}`);
    }

    const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM credit_transactions
       ${whereSql}`,
      params
    );

    params.push(limit);
    params.push(offset);

    const rowsResult = await pool.query(
      `SELECT id, type, credits_amount, description, service_name, created_at
       FROM credit_transactions
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const total = Number.parseInt(countResult.rows[0]?.total || '0', 10);
    return {
      transactions: rowsResult.rows,
      pagination: {
        page,
        limit,
        totalCount: total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }
}

export const creditService = new CreditService();
