'use strict';

const { isQuiet } = require('./modes');

/**
 * Sends WhatsApp messages to the user, holding back non-urgent ones during
 * quiet hours. Held messages are sent together when quiet hours end.
 *
 * @param {object} deps
 * @param {(text: string) => Promise<void>} deps.send
 * @param {{ start: number, end: number } | null} deps.quietHours
 * @param {string} deps.timezone
 * @param {object} deps.logger
 * @param {() => Date} [deps.now]
 */
function createNotifier({ send, quietHours, timezone, logger, now = () => new Date() }) {
  let held = [];

  const quietNow = () => isQuiet(quietHours, timezone, now());

  /**
   * @param {string} text
   * @param {{ holdable?: boolean }} [options] holdable messages wait for quiet hours to end
   * @returns {Promise<'sent'|'held'>}
   */
  async function notify(text, { holdable = false } = {}) {
    if (holdable && quietNow()) {
      held.push(text);
      return 'held';
    }
    await send(text);
    return 'sent';
  }

  /** Sends held messages if quiet hours are over. */
  async function flushHeld() {
    if (!held.length || quietNow()) return 0;
    const items = held;
    held = [];
    try {
      await send(`🌙 *وصل ده وقت الهدوء:*\n\n${items.join('\n\n')}`);
      return items.length;
    } catch (err) {
      held = items.concat(held);
      logger.error('Could not send held alerts:', err.message);
      return 0;
    }
  }

  const timer = setInterval(flushHeld, 60 * 1000);
  if (timer.unref) timer.unref();

  return {
    notify,
    flushHeld,
    heldCount: () => held.length,
    isQuietNow: quietNow,
    stop: () => clearInterval(timer),
  };
}

module.exports = { createNotifier };
