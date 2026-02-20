import OpenAI from 'openai';
import axios from 'axios';

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'sonar';
const DEFAULT_GOOGLE_MODEL = process.env.GOOGLE_AI_MODEL || 'gemini-2.5-flash';
const PROVIDER_TIMEOUT_MS = Number.parseInt(process.env.AI_PROVIDER_TIMEOUT_MS || '30000', 10);
const PROVIDER_MAX_RETRIES = Math.max(1, Number.parseInt(process.env.AI_PROVIDER_MAX_RETRIES || '2', 10));
const DEFAULT_CAPTION_MAX_CHARS = Math.max(120, Number.parseInt(process.env.AI_CAPTION_MAX_CHARS || '500', 10));
const PLATFORM_CAPTION_LIMITS = {
  instagram: Math.max(120, Number.parseInt(process.env.INSTAGRAM_CAPTION_MAX_CHARS || '2200', 10)),
  threads: Math.max(120, Number.parseInt(process.env.THREADS_TEXT_MAX_CHARS || '500', 10)),
  youtube: Math.max(120, Number.parseInt(process.env.YOUTUBE_CAPTION_MAX_CHARS || '5000', 10)),
};

const SUPPORTED_PROVIDER_ORDER = ['perplexity', 'google', 'openai'];

const normalizeProviderOrder = (value) => {
  const raw = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const deduped = raw.filter((provider, index) => SUPPORTED_PROVIDER_ORDER.includes(provider) && raw.indexOf(provider) === index);
  return deduped.length > 0 ? deduped : SUPPORTED_PROVIDER_ORDER;
};

const PROVIDER_PRIORITY = normalizeProviderOrder(process.env.AI_PROVIDER_PRIORITY);

const rateLimits = new Map();

const checkRateLimit = (userId) => {
  if (!userId) {
    return { allowed: true };
  }

  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const maxRequests = 50;
  const record = rateLimits.get(userId);

  if (!record || now >= record.resetAt) {
    rateLimits.set(userId, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (record.count >= maxRequests) {
    const resetInMinutes = Math.ceil((record.resetAt - now) / 60000);
    return {
      allowed: false,
      error: `Rate limit exceeded. Try again in ${resetInMinutes} minute(s).`,
    };
  }

  record.count += 1;
  return { allowed: true };
};

const resolveCaptionLimit = (platforms = []) => {
  const normalized = Array.isArray(platforms)
    ? [...new Set(platforms.map((platform) => String(platform || '').toLowerCase()))]
    : [];

  const limits = normalized
    .map((platform) => PLATFORM_CAPTION_LIMITS[platform])
    .filter((value) => Number.isFinite(value) && value > 0);

  if (limits.length === 0) {
    return DEFAULT_CAPTION_MAX_CHARS;
  }

  return Math.max(120, Math.min(...limits));
};

const buildCaptionSystemPrompt = ({ style, platforms, maxChars }) => {
  const toneMap = {
    casual: 'friendly and conversational',
    professional: 'professional and polished',
    witty: 'witty and sharp',
    humorous: 'lightly humorous and playful',
    inspirational: 'inspirational and motivating',
    informative: 'informative and practical',
  };

  const selectedTone = toneMap[style] || toneMap.casual;
  const platformLine = platforms.length > 0 ? platforms.join(' + ') : 'Instagram + Threads';

  return [
    'You are a social media strategist for Instagram, Threads, and YouTube.',
    `Write one caption optimized for: ${platformLine}.`,
    `Tone: ${selectedTone}.`,
    'Include a strong hook, value line, and clear CTA.',
    'Add relevant hashtags naturally at the end.',
    `Keep output under ${maxChars} characters.`,
    'Return plain text only (no markdown).',
  ].join(' ');
};

const sanitizePrompt = (prompt) => {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Invalid prompt');
  }

  const cleaned = prompt.trim();
  if (cleaned.length < 5) {
    throw new Error('Prompt must be at least 5 characters');
  }

  if (cleaned.length > 2000) {
    throw new Error('Prompt is too long (max 2000 characters)');
  }

  const blockedPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions/gi,
    /disregard\s+(all\s+)?prior\s+instructions/gi,
    /system\s*:\s*you\s+are/gi,
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(cleaned)) {
      throw new Error('Prompt contains disallowed instruction patterns');
    }
  }

  return cleaned;
};

const toPath = (baseUrl, suffix) => `${String(baseUrl || '').replace(/\/$/, '')}${suffix}`;

const normalizeProviderError = (provider, error) => {
  const message =
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    `${provider} provider failed`;

  const normalized = new Error(`${provider}: ${message}`);
  normalized.status = error?.response?.status;

  if (/quota|rate limit|too many requests/i.test(message)) {
    normalized.isQuota = true;
  }

  const retryAfterHeader = error?.response?.headers?.['retry-after'];
  if (retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))) {
    normalized.retryAfter = Number(retryAfterHeader);
  }

  return normalized;
};

const cleanupCaption = (text, maxChars) => {
  if (!text || typeof text !== 'string') {
    return '';
  }

  let caption = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s*sources?:\s*.*$/gim, '')
    .replace(/^here(?:\'s| is)\s+(?:your\s+)?caption:\s*/i, '')
    .trim();

  if (caption.length > maxChars) {
    caption = `${caption.slice(0, maxChars - 3).trim()}...`;
  }

  return caption;
};

const extractProviderKey = (provider, preference, userKeys = []) => {
  if (preference === 'byok') {
    const providerAlias = provider === 'google' ? ['google', 'gemini'] : [provider];
    const byokKey = userKeys.find((item) => providerAlias.includes(String(item?.provider || '').toLowerCase()));
    const apiKey = byokKey?.apiKey || byokKey?.api_key || byokKey?.key || '';

    if (apiKey) {
      return { key: apiKey, keyType: 'BYOK' };
    }

    return { key: '', keyType: 'BYOK' };
  }

  if (provider === 'perplexity') {
    return { key: process.env.PERPLEXITY_API_KEY || '', keyType: 'platform' };
  }

  if (provider === 'google') {
    return { key: process.env.GOOGLE_AI_API_KEY || '', keyType: 'platform' };
  }

  return { key: process.env.OPENAI_API_KEY || '', keyType: 'platform' };
};

const getUserPreferenceAndKeys = async (userToken) => {
  if (!userToken) {
    return { preference: 'platform', userKeys: [] };
  }

  const baseUrl = process.env.NEW_PLATFORM_API_URL || 'http://localhost:3000/api';
  const headers = { Authorization: `Bearer ${userToken}` };

  const prefResponse = await axios.get(toPath(baseUrl, '/byok/preference'), {
    headers,
    timeout: 5000,
  });

  const preference = prefResponse.data?.api_key_preference || prefResponse.data?.preference || 'platform';
  if (preference !== 'byok') {
    return { preference: 'platform', userKeys: [] };
  }

  const keysResponse = await axios.get(toPath(baseUrl, '/byok/keys'), {
    headers,
    timeout: 5000,
  });

  return {
    preference: 'byok',
    userKeys: Array.isArray(keysResponse.data?.keys) ? keysResponse.data.keys : [],
  };
};

class AIService {
  constructor() {
    this.openaiClient = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  }

  async generateCaption({ prompt, platforms = [], style = 'casual', userToken = null, userId = null }) {
    const sanitizedPrompt = sanitizePrompt(prompt);
    const maxChars = resolveCaptionLimit(platforms);

    const rateResult = checkRateLimit(userId);
    if (!rateResult.allowed) {
      throw new Error(rateResult.error);
    }

    let preference = 'platform';
    let userKeys = [];

    if (userToken) {
      try {
        const byokData = await getUserPreferenceAndKeys(userToken);
        preference = byokData.preference;
        userKeys = byokData.userKeys;
      } catch (error) {
        // Fall back to platform mode when BYOK lookup fails.
        preference = 'platform';
        userKeys = [];
      }
    }

    const providers = PROVIDER_PRIORITY
      .map((provider) => {
        const { key, keyType } = extractProviderKey(provider, preference, userKeys);
        if (!key) return null;

        if (provider === 'perplexity') {
          return {
            name: 'perplexity',
            keyType,
            run: () => this.generateWithPerplexity({ prompt: sanitizedPrompt, style, platforms, maxChars, apiKey: key }),
          };
        }

        if (provider === 'google') {
          return {
            name: 'google',
            keyType,
            run: () => this.generateWithGoogle({ prompt: sanitizedPrompt, style, platforms, maxChars, apiKey: key }),
          };
        }

        return {
          name: 'openai',
          keyType,
          run: () => this.generateWithOpenAI({ prompt: sanitizedPrompt, style, platforms, maxChars, apiKey: key }),
        };
      })
      .filter(Boolean);

    if (providers.length === 0) {
      const mode = preference === 'byok' ? 'BYOK' : 'platform';
      throw new Error(`No AI providers configured for ${mode} mode`);
    }

    let lastError = null;

    for (const provider of providers) {
      for (let attempt = 1; attempt <= PROVIDER_MAX_RETRIES; attempt += 1) {
        try {
          const output = await provider.run();
          const caption = cleanupCaption(output, maxChars);
          if (!caption) {
            throw new Error('Provider returned empty caption');
          }

          return {
            caption,
            provider: provider.name,
            keyType: provider.keyType,
            mode: preference,
          };
        } catch (error) {
          lastError = normalizeProviderError(provider.name, error);

          if (lastError.isQuota && attempt < PROVIDER_MAX_RETRIES) {
            const waitSeconds = Number.isFinite(lastError.retryAfter) ? lastError.retryAfter : Math.min(5 * attempt, 15);
            await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitSeconds * 1000)));
            continue;
          }

          break;
        }
      }
    }

    throw lastError || new Error('All AI providers failed');
  }

  async generateWithOpenAI({ prompt, style, platforms, maxChars, apiKey }) {
    const client =
      this.openaiClient && apiKey === process.env.OPENAI_API_KEY
        ? this.openaiClient
        : new OpenAI({ apiKey });

    const completion = await client.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      messages: [
        { role: 'system', content: buildCaptionSystemPrompt({ style, platforms, maxChars }) },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      max_tokens: 260,
      timeout: PROVIDER_TIMEOUT_MS,
    });

    return completion.choices?.[0]?.message?.content?.trim() || '';
  }

  async generateWithPerplexity({ prompt, style, platforms, maxChars, apiKey }) {
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: DEFAULT_PERPLEXITY_MODEL,
        messages: [
          { role: 'system', content: buildCaptionSystemPrompt({ style, platforms, maxChars }) },
          { role: 'user', content: prompt },
        ],
        max_tokens: 260,
        temperature: 0.8,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: PROVIDER_TIMEOUT_MS,
      }
    );

    return response.data?.choices?.[0]?.message?.content?.trim() || response.data?.output_text?.trim() || '';
  }

  async generateWithGoogle({ prompt, style, platforms, maxChars, apiKey }) {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GOOGLE_MODEL}:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            parts: [
              {
                text: `${buildCaptionSystemPrompt({ style, platforms, maxChars })}\n\nPrompt: ${prompt}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 260,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: PROVIDER_TIMEOUT_MS,
      }
    );

    return response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }
}

const aiService = new AIService();

export const generateCaption = async (input) => aiService.generateCaption(input);
