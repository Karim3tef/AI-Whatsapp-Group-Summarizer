'use strict';

const { splitText } = require('./chunker');
const { MERGE_INSTRUCTION } = require('./prompt');

// WhatsApp accepts long messages, but very long ones get cut. Stay well below.
const WHATSAPP_MAX = 60000;

/** Turns stored messages into one plain-text transcript, one line per message. */
function formatTranscript(messages) {
  return messages
    .map((m) => `[${m.group}] ${m.time} - ${m.from}: ${String(m.text).replace(/\s*\n\s*/g, ' ')}`)
    .join('\n');
}

/**
 * Creates the summarize() function.
 *
 * Flow: snapshot the queue -> split into chunks -> summarize each chunk ->
 * merge the partial summaries (if more than one) -> send to WhatsApp (if
 * delivering) -> save to history -> remove only the messages that were
 * summarized -> notify listeners (webhook). On any error the queue is left
 * untouched, so the next run picks the messages up again.
 *
 * @param {object} deps
 * @param {import('./storage').MessageStore} deps.store
 * @param {import('./storage').SummaryStore} [deps.summaries]
 * @param {{ ask: (system: string, user: string) => Promise<string> }} deps.ai
 * @param {(text: string) => Promise<void>} deps.send  Sends a WhatsApp message to the user
 * @param {string} deps.prompt
 * @param {number} deps.chunkSize
 * @param {number} deps.chunkWait
 * @param {boolean | (() => boolean)} [deps.deliverByDefault=true]  Send results to WhatsApp unless told otherwise
 * @param {(summary: object) => void} [deps.onSummary]  Called after each new summary
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {object} deps.logger
 */
function createSummarizer({
  store,
  summaries,
  ai,
  send,
  prompt,
  chunkSize,
  chunkWait,
  deliverByDefault = true,
  onSummary,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger,
}) {
  let busy = false;
  let lastRun = null;

  async function safeSend(text) {
    try {
      await send(text);
    } catch (err) {
      logger.error('Could not send message to self:', err.message);
    }
  }

  /**
   * @param {{ reason?: string, deliver?: boolean, quietIfEmpty?: boolean }} [options]
   * @returns {Promise<{ status: 'busy'|'empty'|'sent'|'failed', count?: number, summary?: object, error?: string }>}
   */
  const defaultDeliver = () => (typeof deliverByDefault === 'function' ? deliverByDefault() : deliverByDefault);

  async function summarize({ reason = 'manual', deliver = defaultDeliver(), quietIfEmpty = false } = {}) {
    const notify = deliver ? safeSend : async () => {};

    if (busy) {
      await notify('⏳ فيه ملخص شغال دلوقتي، استنى لما يخلص.');
      return { status: 'busy' };
    }
    busy = true;
    try {
      const batch = store.snapshot();
      if (batch.length === 0) {
        if (!quietIfEmpty) await notify('📋 مفيش رسايل جديدة في الجروبات.');
        lastRun = { at: new Date(), status: 'empty', reason };
        return { status: 'empty' };
      }

      logger.info(`Summarizing ${batch.length} message(s) (${reason})`);
      const chunks = splitText(formatTranscript(batch), chunkSize);

      const parts = [];
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(chunkWait);
        logger.info(`Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
        parts.push(await ai.ask(prompt, chunks[i]));
      }

      let text = parts[0];
      if (parts.length > 1) {
        await sleep(chunkWait);
        logger.info(`Merging ${parts.length} partial summaries`);
        text = await ai.ask(`${prompt}\n\n${MERGE_INSTRUCTION}`, parts.join('\n\n---\n\n'));
      }

      if (deliver) {
        const header = `📋 *ملخص الجروبات* (${batch.length} رسالة)\n\n`;
        for (const piece of splitText(header + text, WHATSAPP_MAX)) await send(piece);
      }

      const groups = [...new Set(batch.map((m) => m.group))];
      const record = { reason, messageCount: batch.length, groups, delivered: deliver, text };
      const summary = summaries ? summaries.add(record) : { createdAt: new Date().toISOString(), ...record };

      store.removeFirst(batch.length);
      lastRun = { at: new Date(), status: 'sent', reason, count: batch.length };
      logger.info(`Summary done (${deliver ? 'sent to WhatsApp' : 'not delivered to WhatsApp'}), cleared ${batch.length} message(s)`);

      if (onSummary) {
        try {
          onSummary(summary);
        } catch (err) {
          logger.error('Summary listener failed:', err.message);
        }
      }
      return { status: 'sent', count: batch.length, summary };
    } catch (err) {
      logger.error('Summary failed:', err.message);
      lastRun = { at: new Date(), status: 'failed', reason, error: err.message };
      await notify('⚠️ حصلت مشكلة في التلخيص. الرسايل محفوظة وهتتلخص المرة الجاية.\n' + `السبب: ${err.message.slice(0, 300)}`);
      return { status: 'failed', error: err.message };
    } finally {
      busy = false;
    }
  }

  return {
    summarize,
    isBusy: () => busy,
    getLastRun: () => lastRun,
  };
}

module.exports = { createSummarizer, formatTranscript };
