'use strict';

const crypto = require('crypto');
const { sign } = require('./crypto');

/**
 * Pushes events (like a new summary) to another project's URL.
 *
 * Each request is signed so the receiver can check it really came from this
 * bot and was not replayed:
 *
 *   X-Summarizer-Timestamp: <unix seconds>
 *   X-Summarizer-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with WEBHOOK_SECRET>
 *
 * Failed deliveries are retried a few times with backoff. Redirects are not
 * followed, so the payload can't be bounced to another host.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.secret
 * @param {number} [options.maxAttempts=4]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {object} options.logger
 */
function createWebhook({
  url,
  secret,
  maxAttempts = 4,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger,
}) {
  /**
   * @param {string} event e.g. "summary.created"
   * @param {object} data
   * @returns {Promise<boolean>} true if delivered
   */
  async function deliver(event, data) {
    const id = crypto.randomUUID();
    const body = JSON.stringify({ id, event, createdAt: new Date().toISOString(), data });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'AI-WhatsApp-Group-Summarizer-Webhook',
            'X-Summarizer-Event': event,
            'X-Summarizer-Delivery': id,
            'X-Summarizer-Timestamp': timestamp,
            'X-Summarizer-Signature': `sha256=${sign(secret, `${timestamp}.${body}`)}`,
          },
          body,
          signal: AbortSignal.timeout(15000),
        });
        if (res.status >= 200 && res.status < 300) {
          logger.info(`Webhook ${event} delivered (${res.status})`);
          return true;
        }
        logger.warn(`Webhook ${event} got HTTP ${res.status} (attempt ${attempt}/${maxAttempts})`);
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
      } catch (err) {
        logger.warn(`Webhook ${event} failed: ${err.message} (attempt ${attempt}/${maxAttempts})`);
      }
      if (attempt < maxAttempts) await sleep(5000 * 3 ** (attempt - 1));
    }
    logger.error(`Webhook ${event} was not delivered.`);
    return false;
  }

  return { deliver };
}

/**
 * Helper for receivers (and tests): checks a webhook request.
 * @param {{ secret: string, body: string, timestamp: string, signature: string, toleranceSec?: number }} p
 */
function verifyWebhookSignature({ secret, body, timestamp, signature, toleranceSec = 300 }) {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSec) return false;
  const expected = Buffer.from(`sha256=${sign(secret, `${timestamp}.${body}`)}`);
  const given = Buffer.from(String(signature || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { createWebhook, verifyWebhookSignature };
