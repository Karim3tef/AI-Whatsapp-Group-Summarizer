'use strict';

const { EventEmitter } = require('events');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');

const { createAIClient } = require('./ai');
const { MessageStore, GroupStore, HistoryStore, SettingsStore } = require('./storage');
const { createSummarizer } = require('./summarizer');
const { createCommandHandler } = require('./commands');
const { createApiServer } = require('./api');
const { createWebhook } = require('./webhook');
const { createRealtimeWatcher } = require('./realtime');
const { createNotifier } = require('./notifier');
const { usesSchedule, usesRealtime } = require('./modes');
const { version } = require('../package.json');

/** Text to store for a message; media without a caption gets a short label. */
function messageText(msg) {
  const body = (msg.body || '').trim();
  if (msg.hasMedia) return body ? `[${msg.type}] ${body}` : `[بعت ${msg.type}]`;
  if (msg.type === 'location') return '[بعت لوكيشن]';
  return body;
}

/** One WhatsApp message for a batch of real-time alerts. */
function formatAlerts(alerts) {
  const byGroup = new Map();
  for (const a of alerts) {
    if (!byGroup.has(a.group)) byGroup.set(a.group, []);
    byGroup.get(a.group).push(`${a.urgent ? '⚠️' : '-'} ${a.text}`);
  }
  const blocks = [...byGroup].map(([group, lines]) => `*${group}*\n${lines.join('\n')}`);
  return `🔔 *تنبيه مهم*\n\n${blocks.join('\n\n')}`;
}

async function senderName(msg) {
  const notify = msg._data && msg._data.notifyName;
  if (notify) return notify;
  try {
    const c = await msg.getContact();
    return c.pushname || c.name || c.number || 'مجهول';
  } catch {
    return 'مجهول';
  }
}

/**
 * Wires WhatsApp, storage, the AI client, the scheduler, real-time alerts,
 * the commands, the HTTP API and the webhook.
 *
 * Every new summary / alert / settings change is emitted on `bus`; the
 * webhook and the API's live stream listen there.
 * @param {ReturnType<import('./config').loadConfig>} config
 * @param {object} logger
 */
function createBot(config, logger) {
  const storeOptions = { encryptionKey: config.encryptionKey, logger };
  const store = new MessageStore(config.messagesFile, { ...storeOptions, maxStored: config.maxStored });
  const groups = new GroupStore(config.groupsFile, { ...storeOptions, initialGroups: config.initialGroups });
  const summaries = new HistoryStore(config.summariesFile, { ...storeOptions, limit: config.summaryHistory });
  const alerts = new HistoryStore(config.alertsFile, { ...storeOptions, limit: config.alertHistory });
  // .env gives the defaults; !وضع and PATCH /v1/settings override them.
  const settings = new SettingsStore(
    config.settingsFile,
    { mode: config.mode, deliverToWhatsApp: config.deliverToWhatsApp },
    storeOptions,
  );
  const ai = createAIClient({ ...config.ai, logger });

  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  if (config.webhook) {
    const webhook = createWebhook({ ...config.webhook, logger });
    for (const event of ['summary.created', 'alert.created']) {
      bus.on(event, (data) => {
        webhook.deliver(event, data).catch(() => {});
      });
    }
  }

  if (config.encryptionKey) logger.info('Data files are encrypted (AES-256-GCM).');

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.authDir }),
    puppeteer: {
      headless: true,
      executablePath: config.chromiumPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  // IDs of the user's own account. Newer WhatsApp versions may address the
  // "Message yourself" chat by a LID instead of the phone-number ID.
  let me = null;
  let ready = false;
  const selfIds = new Set();
  const send = async (text) => {
    if (!ready) throw new Error('WhatsApp is not connected yet');
    await client.sendMessage(me, text);
  };
  const notifier = createNotifier({ send, quietHours: config.quietHours, timezone: config.timezone, logger });

  const summarizer = createSummarizer({
    store,
    summaries,
    ai,
    send,
    prompt: config.prompt,
    chunkSize: config.chunkSize,
    chunkWait: config.chunkWait,
    // Read the live setting on every run, so changes apply right away.
    deliverByDefault: () => settings.get('deliverToWhatsApp'),
    onSummary: (summary) => bus.emit('summary.created', summary),
    logger,
  });

  const realtime = createRealtimeWatcher({
    ai,
    prompt: config.realtime.prompt,
    debounceMs: config.realtime.debounceMs,
    maxWaitMs: config.realtime.maxWaitMs,
    chunkSize: config.chunkSize,
    logger,
    async onAlerts(found) {
      for (const a of found) bus.emit('alert.created', alerts.add(a));
      if (!settings.get('deliverToWhatsApp')) return;
      const urgent = found.some((a) => a.urgent);
      const holdable = !(urgent && config.quietHoursAllowUrgent);
      try {
        await notifier.notify(formatAlerts(found), { holdable });
      } catch (err) {
        logger.error('Could not send alert:', err.message);
      }
    },
  });

  const getRuntime = () => ({
    realtimePending: realtime.pending(),
    lastRealtimeCheck: realtime.getLastCheck(),
    heldAlerts: notifier.heldCount(),
    quietNow: notifier.isQuietNow(),
  });

  let task = null;
  const getNextRun = () => (task ? task.getNextRun() : null);
  const listGroupChats = async () =>
    (await client.getChats()).filter((c) => c.isGroup).map((c) => ({ id: c.id._serialized, name: c.name }));

  const handleCommand = createCommandHandler({
    send,
    listGroupChats,
    store,
    groups,
    // Commands come from WhatsApp, so always answer there.
    summarizer: { ...summarizer, summarize: (o) => summarizer.summarize({ ...o, deliver: true }) },
    getNextRun,
    model: config.ai.model,
    timezone: config.timezone,
    settings,
    alerts,
    getRuntime,
    onSettingsChange: (all) => bus.emit('settings.updated', all),
  });

  const api = config.api.enabled
    ? createApiServer({
        apiConfig: config.api,
        store,
        groups,
        summaries,
        alerts,
        settings,
        bus,
        getRuntime,
        summarizer,
        listGroupChats,
        isReady: () => ready,
        getNextRun,
        info: {
          version,
          model: config.ai.model,
          schedule: config.schedule,
          timezone: config.timezone,
          quietHours: config.quietHours ? config.quietHours.text : null,
        },
        logger,
      })
    : null;

  client.on('qr', (qr) => {
    logger.info('Scan this QR code from WhatsApp > Linked devices > Link a device:');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => logger.info('Authenticated, session saved.'));
  client.on('auth_failure', (m) => logger.error('Authentication failed:', m));

  client.on('ready', async () => {
    me = client.info.wid._serialized;
    selfIds.add(me);
    try {
      const [ids] = await client.getContactLidAndPhone([me]);
      if (ids && ids.lid) selfIds.add(ids.lid);
    } catch (err) {
      logger.warn('Could not look up own LID:', err.message);
    }
    ready = true;

    logger.info(
      `✅ WhatsApp connected. Mode: ${settings.get('mode')}. Watching ${groups.count} group(s), ${store.count} message(s) pending.`,
    );
    if (groups.count === 0) {
      logger.warn('No groups watched yet. Send !جروبات then !تابع <number> in your "Message yourself" chat, or use the API.');
    }

    // 'ready' can fire again after a reconnect; schedule only once.
    if (!task) {
      // The job always exists; it only summarizes when the mode includes the schedule.
      const onTick = () => {
        if (usesSchedule(settings.get('mode'))) summarizer.summarize({ reason: 'schedule' });
      };
      task = cron.schedule(config.schedule, onTick, {
        timezone: config.timezone,
        name: 'summary',
      });
      logger.info(`Summary scheduled "${config.schedule}" (${config.timezone}), next: ${task.getNextRun()}`);
    }
  });

  client.on('disconnected', (reason) => {
    ready = false;
    logger.error('Disconnected from WhatsApp:', reason);
    // Exit so pm2 / Docker restarts the process with a clean browser.
    process.exit(1);
  });

  // Messages from other people. Store the ones from watched groups.
  client.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      if (!chat.isGroup) return;
      const info = { id: chat.id._serialized, name: chat.name };
      if (!groups.matches(info)) return;

      const text = messageText(msg);
      if (!text) return;
      const from = await senderName(msg);

      const record = {
        group: chat.name,
        groupId: info.id,
        from,
        time: new Date(msg.timestamp * 1000).toLocaleString('ar-EG', { timeZone: config.timezone }),
        timestamp: msg.timestamp,
        text,
      };
      // Always queued, so !ملخص works in every mode.
      store.add(record);
      if (usesRealtime(settings.get('mode'))) realtime.push(record);

      // Keyword alerts: instant, no AI involved.
      if (config.urgentKeywords.some((w) => text.includes(w))) {
        await notifier.notify(`🔔 *${chat.name}*\n${from}: ${text}`);
      }
    } catch (err) {
      logger.error('Could not store message:', err.message);
    }
  });

  // Messages the user sends. Only those in "Message yourself" can be commands.
  client.on('message_create', async (msg) => {
    if (!ready || !msg.fromMe || !selfIds.has(msg.to)) return;
    try {
      await handleCommand(msg.body);
    } catch (err) {
      logger.error('Command failed:', err.message);
      try {
        await send(`⚠️ الأمر فشل: ${err.message.slice(0, 300)}`);
      } catch {
        /* nothing else to do */
      }
    }
  });

  return {
    client,
    async start() {
      if (api) await api.listen();
      await client.initialize();
    },
    async stop() {
      if (task) await task.stop();
      realtime.stop();
      notifier.stop();
      if (api) await api.close();
      try {
        await client.destroy();
      } catch {
        /* browser may already be gone */
      }
    },
  };
}

module.exports = { createBot, messageText, formatAlerts };
