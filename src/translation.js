/**
 * Translation module — wraps AI provider calls.
 *
 * Supported providers:
 *  - "anthropic"  → Claude via @anthropic-ai/sdk  (requires ANTHROPIC_API_KEY)
 *  - "openai"     → OpenAI chat completions       (requires OPENAI_API_KEY)
 *
 * Translation is disabled by default per pair.
 * Enable it in the dashboard and select source → target language.
 */

import Anthropic from '@anthropic-ai/sdk';

const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/**
 * Translate `text` to `targetLanguage` using the configured provider.
 * Returns the original text unchanged if translation fails or is unavailable.
 *
 * @param {string} text
 * @param {string} targetLanguage  e.g. "English", "German", "French"
 * @param {'anthropic'|'openai'} provider
 * @returns {Promise<string>}
 */
export async function translate(text, targetLanguage, provider = 'anthropic') {
  if (!text || !text.trim()) return text;

  const prompt =
    `Translate the following message to ${targetLanguage}. ` +
    `Return ONLY the translated text, no explanations or extra formatting.\n\n` +
    `Message:\n${text}`;

  try {
    if (provider === 'anthropic') {
      return await translateWithAnthropic(prompt);
    }
    if (provider === 'openai') {
      return await translateWithOpenAI(prompt);
    }
    console.warn(`[translation] Unknown provider "${provider}", skipping translation.`);
    return text;
  } catch (err) {
    console.error(`[translation] ${provider} error:`, err.message);
    return text;
  }
}

async function translateWithAnthropic(prompt) {
  if (!anthropicClient) {
    console.warn('[translation] ANTHROPIC_API_KEY not set — translation skipped.');
    return null;
  }

  const response = await anthropicClient.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0]?.text?.trim() ?? null;
}

async function translateWithOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[translation] OPENAI_API_KEY not set — translation skipped.');
    return null;
  }

  const { default: fetch } = await import('node-fetch');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024
    })
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? null;
}

/**
 * Apply translation based on a pair's translation config.
 *
 * @param {string} text
 * @param {object} translationConfig  pair.translation
 * @param {'tgToDiscord'|'discordToTg'} direction
 * @returns {Promise<string>}
 */
export async function maybeTranslate(text, translationConfig, direction) {
  if (!translationConfig?.enabled) return text;

  const dirConfig = translationConfig[direction];
  if (!dirConfig?.enabled) return text;

  const translated = await translate(
    text,
    dirConfig.targetLanguage || 'English',
    translationConfig.provider || 'anthropic'
  );

  // Fall back to original if translation returned null/empty
  return translated || text;
}
