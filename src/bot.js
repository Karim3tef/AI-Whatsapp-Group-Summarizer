'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');

const { createAIClient } = require('./ai');
const { MessageStore, GroupStore, HistoryStore, SettingsStore } = require('./storage');
const { createSummarizer } = require('./summarizer');
const { createCommandHandler, INVISIBLE } = require('./commands');
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

/**
 * Chromium leaves Singleton* lock files in its profile when it is killed.
 * A new container has a new hostname, so Chromium then thinks another
 * machine owns the profile and refuses to start. Only this process uses
 * the session, so the locks are always stale here.
 */
function clearChromiumLocks(authDir) {
  const profile = path.join(authDir, 'session');
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    fs.rmSync(path.join(profile, name), { force: true });
  }
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
  // Read groups straight from WhatsApp Web's in-memory chat list.
  // client.getChats() and msg.getChat() also fetch every group's members
  // from the server, which can take minutes on big accounts and time out.
  // `ids` limits the result to those group IDs.
  const groupChats = (ids = null) =>
    client.pupPage.evaluate((ids) => {
      const { Chat } = window.require('WAWebCollections');
      const { createWid } = window.require('WAWebWidFactory');
      const chats = ids ? ids.map((id) => Chat.get(createWid(id))) : Chat.getModelsArray();
      return chats
        .filter((c) => c && c.id.server === 'g.us')
        .map((c) => ({ id: c.id._serialized || c.id.toString(), name: c.formattedTitle || c.name || '' }));
    }, ids);
  const listGroupChats = () => groupChats();

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
    logger.info(`Commands are read from your "Message yourself" chat (${[...selfIds].join(', ')}).`);

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
    if (reason === 'LOGOUT') {
      // The library deletes the dead session only after this event, but we
      // exit right away, so delete it here. Otherwise every restart loads the
      // same logged-out session and fails again.
      fs.rmSync(path.join(config.authDir, 'session'), { recursive: true, force: true });
      logger.warn('WhatsApp session removed. Restarting; scan the new QR code to link again.');
    }
    // Exit so pm2 / Docker restarts the process with a clean browser.
    process.exit(1);
  });

  // Messages from other people. Store the ones from watched groups.
  client.on('message', async (msg) => {
    try {
      // In a group message, `from` is the group and `author` the sender.
      if (!msg.from || !msg.from.endsWith('@g.us')) return;
      const [info] = await groupChats([msg.from]);
      if (!info || !groups.matches(info)) return;
      const chat = info;

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
      logger.error('Could not store message:', err.stack || err.message);
    }
  });

  // Messages the user sends. Only those in "Message yourself" can be commands.
  client.on('message_create', async (msg) => {
    if (!ready || !msg.fromMe) return;
    // In "Message yourself" the message goes from you to you.
    const toSelf = selfIds.has(msg.to) || msg.to === msg.from;
    if (!toSelf) {
      // Say why a command was ignored, so a changed self ID is easy to spot.
      if ((msg.body || '').trim().startsWith('!')) {
        logger.warn(`Ignored "${msg.body.trim().slice(0, 30)}": sent to ${msg.to}, not to yourself (${[...selfIds].join(', ')}).`);
      }
      return;
    }
    const body = (msg.body || '').replace(INVISIBLE, '').trim();
    if (!body.startsWith('!')) return;
    try {
      logger.info(`Command received: ${body.slice(0, 40)}`);
      const known = await handleCommand(body);
      if (!known) {
        logger.warn(`Unknown command: ${body.slice(0, 40)}`);
        await send('❓ أمر مش معروف. ابعت *!مساعدة* عشان تشوف الأوامر.');
      }
    } catch (err) {
      logger.error('Command failed:', err.stack || err.message);
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
      clearChromiumLocks(config.authDir);
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

module.exports = { createBot, messageText, formatAlerts, clearChromiumLocks };
