'use strict';

const { splitText } = require('./chunker');
const { formatTranscript } = require('./summarizer');

/**
 * Pulls the alerts out of the model's answer. Models sometimes wrap JSON in
 * text or code fences, so take the outermost {...} block.
 * @returns {Array<{ group: string, text: string, urgent: boolean }>}
 */
function parseAlerts(answer) {
  const s = String(answer || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('AI answer had no JSON');
  const data = JSON.parse(s.slice(start, end + 1));
  const list = Array.isArray(data.alerts) ? data.alerts : [];
  return list
    .filter((a) => a && typeof a.text === 'string' && a.text.trim())
    .slice(0, 10)
    .map((a) => ({
      group: typeof a.group === 'string' && a.group.trim() ? a.group.trim() : 'جروب',
      text: a.text.trim().slice(0, 1000),
      urgent: a.urgent === true,
    }));
}

/**
 * Watches new messages and raises alerts for the important ones right away.
 *
 * To stay within free AI limits it does not call the AI for every message:
 * it waits until the group goes quiet for `debounceMs` (or at most
 * `maxWaitMs` after the first new message) and checks the whole batch in one
 * request.
 *
 * @param {object} deps
 * @param {{ ask: Function }} deps.ai
 * @param {string} deps.prompt
 * @param {number} deps.debounceMs
 * @param {number} deps.maxWaitMs
 * @param {number} deps.chunkSize
 * @param {(alerts: Array, batch: Array) => Promise<void>|void} deps.onAlerts
 * @param {object} deps.logger
 */
function createRealtimeWatcher({ ai, prompt, debounceMs, maxWaitMs, chunkSize, onAlerts, logger }) {
  let buffer = [];
  let firstAt = 0;
  let timer = null;
  let running = false;
  let again = false;
  let stopped = false;
  let lastCheck = null;

  function arm() {
    clearTimeout(timer);
    const left = Math.max(0, maxWaitMs - (Date.now() - firstAt));
    timer = setTimeout(flush, Math.min(debounceMs, left));
    if (timer.unref) timer.unref();
  }

  /** Adds a new message to the next check. */
  function push(message) {
    if (stopped) return;
    if (!buffer.length) firstAt = Date.now();
    buffer.push(message);
    arm();
  }

  /** Checks everything buffered now. Safe to call any time. */
  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (!buffer.length) return [];
    if (running) {
      again = true;
      return [];
    }
    running = true;
    const batch = buffer;
    buffer = [];
    const found = [];
    try {
      for (const chunk of splitText(formatTranscript(batch), chunkSize)) {
        found.push(...parseAlerts(await ai.ask(prompt, chunk)));
      }
      lastCheck = { at: new Date(), messages: batch.length, alerts: found.length };
      logger.info(`Real-time check: ${batch.length} message(s), ${found.length} alert(s)`);
      if (found.length) await onAlerts(found, batch);
    } catch (err) {
      lastCheck = { at: new Date(), messages: batch.length, error: err.message };
      // The messages are still in the main queue for the next summary.
      logger.error('Real-time check failed:', err.message);
    } finally {
      running = false;
      if (again || buffer.length) {
        again = false;
        if (buffer.length && !stopped) {
          firstAt = Date.now();
          arm();
        }
      }
    }
    return found;
  }

  return {
    push,
    flush,
    pending: () => buffer.length,
    getLastCheck: () => lastCheck,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

module.exports = { createRealtimeWatcher, parseAlerts };
