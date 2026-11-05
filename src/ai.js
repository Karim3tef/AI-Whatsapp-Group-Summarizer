'use strict';

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

class AIError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AIError';
    this.status = status;
  }
}

/** Seconds from a Retry-After header, or null. */
function retryAfterMs(headers) {
  const value = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Client for any OpenAI-compatible chat completions API (Groq, OpenRouter,
 * Ollama, OpenAI, ...). Retries rate limits and server errors with backoff.
 *
 * @param {object} options
 * @param {string} options.url        Full chat completions URL
 * @param {string} options.key        API key
 * @param {string} options.model      Model name
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.timeoutMs=120000]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {object} [options.logger]
 */
function createAIClient({
  url,
  key,
  model,
  maxRetries = 3,
  timeoutMs = 120000,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger,
}) {
  async function once(system, user) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          // Optional OpenRouter attribution headers; ignored by other providers.
          'HTTP-Referer': 'https://github.com/Karim3tef/AI-Whatsapp-Group-Summarizer',
          'X-Title': 'AI WhatsApp Group Summarizer',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network error or timeout: worth retrying.
      const e = new AIError(`Request failed: ${err.message}`, 0);
      e.retryable = true;
      throw e;
    }

    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    if (!res.ok) {
      const detail = data && data.error ? data.error.message || JSON.stringify(data.error) : raw.slice(0, 300);
      const e = new AIError(`AI error ${res.status}: ${detail}`, res.status);
      e.retryable = RETRYABLE.has(res.status);
      e.retryAfter = retryAfterMs(res.headers);
      throw e;
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (!content || !String(content).trim()) {
      throw new AIError(`AI returned an empty answer: ${raw.slice(0, 300)}`, res.status);
    }
    return String(content).trim();
  }

  /**
   * @param {string} system Instructions
   * @param {string} user   Content to work on
   * @returns {Promise<string>}
   */
  async function ask(system, user) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(system, user);
      } catch (err) {
        if (!err.retryable || attempt >= maxRetries) throw err;
        const backoff = err.retryAfter != null ? err.retryAfter : Math.min(2 ** attempt * 5000, 60000);
        if (logger) logger.warn(`${err.message}. Retrying in ${Math.round(backoff / 1000)}s (${attempt + 1}/${maxRetries})`);
        await sleep(backoff);
      }
    }
  }

  return { ask, model };
}

module.exports = { createAIClient, AIError };
