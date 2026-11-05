'use strict';

const { MODE_NAMES_AR, parseMode } = require('./modes');

/**
 * Commands the user sends to their own "Message yourself" chat.
 * Arabic and English names both work. Arabic letter variants
 * (أ/إ/آ -> ا, ى -> ي, ة -> ه) are treated the same, so "!إلغاء" == "!الغاء".
 */
const COMMANDS = [
  { key: 'summary', names: ['ملخص', 'summary'], help: 'ملخص فوري للرسايل المتجمعة' },
  { key: 'groups', names: ['جروبات', 'groups'], help: 'كل جروباتك بأرقام، و✅ جنب اللي البوت بيتابعها' },
  { key: 'watch', names: ['تابع', 'watch'], args: '<رقم أو اسم>', help: 'ابدأ تتابع جروب' },
  { key: 'unwatch', names: ['الغي', 'إلغاء', 'unwatch'], args: '<رقم أو اسم>', help: 'وقف متابعة جروب' },
  { key: 'watching', names: ['متابعة', 'watching'], help: 'الجروبات اللي البوت بيتابعها بس' },
  { key: 'mode', names: ['وضع', 'mode'], args: '[مجدول | فوري | الاتنين]', help: 'يعرض أو يغيّر طريقة التنبيه' },
  { key: 'alerts', names: ['تنبيهات', 'alerts'], help: 'آخر التنبيهات الفورية' },
  { key: 'status', names: ['حالة', 'status'], help: 'حالة البوت وعدد الرسايل المستنية' },
  { key: 'clear', names: ['مسح', 'clear'], help: 'مسح الرسايل المستنية من غير تلخيص' },
  { key: 'help', names: ['مساعدة', 'أوامر', 'help'], help: 'قايمة الأوامر' },
];

function normalize(word) {
  return word
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ً-ْـ]/g, ''); // tashkeel and tatweel
}

const LOOKUP = new Map();
for (const cmd of COMMANDS) for (const name of cmd.names) LOOKUP.set(normalize(name), cmd.key);

/**
 * Parses "!command args". Returns null if the text is not a known command.
 * @param {string} text
 */
function parseCommand(text) {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('!')) return null;
  const [word, ...rest] = trimmed.slice(1).split(/\s+/);
  const key = LOOKUP.get(normalize(word || ''));
  if (!key) return null;
  return { key, args: rest.join(' ').trim() };
}

function helpText() {
  const lines = COMMANDS.map((c) => `- *!${c.names[0]}*${c.args ? ' ' + c.args : ''}: ${c.help}`);
  return `*الأوامر:*\n${lines.join('\n')}\n\nممكن تكتبها بالإنجليزي كمان (مثلًا !${COMMANDS[0].names[1]}).`;
}

function formatDuration(ms) {
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const parts = [];
  if (days) parts.push(`${days} يوم`);
  if (hours) parts.push(`${hours} ساعة`);
  parts.push(`${mins % 60} دقيقة`);
  return parts.join(' و ');
}

/** Sorted list so the numbers shown by !جروبات stay stable between commands. */
function sortChats(chats) {
  return chats.slice().sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

/**
 * Finds one chat by its number in the sorted list, its exact name, or a
 * unique part of its name.
 * @returns {{ chat?: {id: string, name: string}, error?: string }}
 */
function resolveChat(arg, chats) {
  if (!arg) return { error: 'اكتب رقم الجروب أو اسمه بعد الأمر. ابعت !جروبات عشان تشوف الأرقام.' };
  const sorted = sortChats(chats);
  if (/^\d+$/.test(arg)) {
    const chat = sorted[Number(arg) - 1];
    return chat ? { chat } : { error: `مفيش جروب برقم ${arg}. ابعت !جروبات عشان تشوف الأرقام.` };
  }
  const exact = sorted.find((c) => c.name === arg);
  if (exact) return { chat: exact };
  const needle = normalize(arg);
  const partial = sorted.filter((c) => normalize(c.name).includes(needle));
  if (partial.length === 1) return { chat: partial[0] };
  if (partial.length > 1) {
    return { error: `فيه أكتر من جروب بالاسم ده:\n${partial.map((c) => '- ' + c.name).join('\n')}\nاكتب الاسم كامل أو استخدم الرقم.` };
  }
  return { error: `ملقتش جروب اسمه "${arg}".` };
}

/**
 * @param {object} deps
 * @param {(text: string) => Promise<void>} deps.send
 * @param {() => Promise<Array<{id: string, name: string}>>} deps.listGroupChats
 * @param {import('./storage').MessageStore} deps.store
 * @param {import('./storage').GroupStore} deps.groups
 * @param {{ summarize: Function, getLastRun: Function }} deps.summarizer
 * @param {() => (Date|null)} deps.getNextRun
 * @param {string} deps.model
 * @param {string} deps.timezone
 * @param {import('./storage').SettingsStore} deps.settings
 * @param {import('./storage').HistoryStore} [deps.alerts]
 * @param {(settings: object) => void} [deps.onSettingsChange]
 * @param {() => object} [deps.getRuntime]
 * @param {number} [deps.startedAt]
 */
function createCommandHandler(deps) {
  const { send, listGroupChats, store, groups, summarizer, getNextRun, model, timezone, settings, alerts } = deps;
  const getRuntime = deps.getRuntime || (() => ({}));
  const startedAt = deps.startedAt || Date.now();
  const fmtDate = (d) => d.toLocaleString('ar-EG', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });

  const handlers = {
    summary: () => summarizer.summarize({ reason: 'command' }),

    help: () => send(helpText()),

    async groups() {
      const chats = sortChats(await listGroupChats());
      if (!chats.length) return send('مفيش جروبات على الحساب ده.');
      const lines = chats.map((c, i) => `${i + 1}. ${groups.isWatched(c) ? '✅ ' : ''}${c.name}`);
      await send(`*جروباتك (${chats.length}):*\n${lines.join('\n')}\n\nعشان تتابع جروب: *!تابع رقم*`);
    },

    async watching() {
      const list = groups.list();
      if (!list.length) return send('البوت مش بيتابع أي جروب لسه. ابعت !جروبات وبعدين !تابع رقم.');
      await send(`*الجروبات المتابعة (${list.length}):*\n${list.map((g) => '- ' + g.name).join('\n')}`);
    },

    async watch(args) {
      const { chat, error } = resolveChat(args, await listGroupChats());
      if (error) return send(error);
      const added = groups.add(chat);
      await send(added ? `✅ بقيت بتابع *${chat.name}*.` : `*${chat.name}* متابَع أصلًا.`);
    },

    async unwatch(args) {
      // A watched group you already left is not in the chat list, so also
      // look it up in the watched list.
      const chats = await listGroupChats();
      const known = new Map(chats.map((c) => [c.id, c]));
      for (const g of groups.list()) if (!g.id || !known.has(g.id)) known.set(g.id || g.name, { id: g.id, name: g.name });
      const { chat, error } = resolveChat(args, [...known.values()]);
      if (error) return send(error);
      const removed = groups.remove(chat);
      await send(removed ? `🛑 وقفت متابعة *${chat.name}*.` : `*${chat.name}* مش متابَع أصلًا.`);
    },

    async mode(args) {
      const modeHelp =
        '- *مجدول*: ملخص واحد في الميعاد المحدد\n- *فوري*: تنبيه أول ما رسالة مهمة توصل\n- *الاتنين*: تنبيهات فورية + الملخص المجدول';
      if (!args) {
        return send(`الوضع الحالي: *${MODE_NAMES_AR[settings.get('mode')]}*\n\n${modeHelp}\n\nللتغيير: *!وضع فوري* مثلًا`);
      }
      const mode = parseMode(args);
      if (!mode) return send(`مش فاهم "${args}". الاختيارات:\n${modeHelp}`);
      settings.set('mode', mode);
      if (deps.onSettingsChange) deps.onSettingsChange(settings.all());
      await send(`✅ الوضع بقى *${MODE_NAMES_AR[mode]}*.`);
    },

    async alerts() {
      const list = alerts ? alerts.list(10) : [];
      if (!list.length) return send('مفيش تنبيهات لسه. التنبيهات الفورية بتشتغل في وضع *فوري* أو *الاتنين* (!وضع).');
      const lines = list.map((a) => `${a.urgent ? '⚠️ ' : '- '}*${a.group}* (${fmtDate(new Date(a.createdAt))})\n  ${a.text}`);
      await send(`*آخر التنبيهات:*\n${lines.join('\n')}`);
    },

    async status() {
      const next = getNextRun();
      const mode = settings.get('mode');
      const rt = getRuntime();
      const last = summarizer.getLastRun();
      const lastText = last
        ? `${fmtDate(last.at)} (${{ sent: 'اتبعت', empty: 'مكانش فيه رسايل', failed: 'فشل' }[last.status]})`
        : 'لسه';
      await send(
        [
          '✅ *البوت شغال*',
          `- الوضع: ${MODE_NAMES_AR[mode]}`,
          `- رسايل مستنية التلخيص: ${store.count}`,
          `- جروبات متابعة: ${groups.count}`,
          mode !== 'realtime' ? `- الملخص الجاي: ${next ? fmtDate(next) : 'مش متحدد'}` : null,
          mode !== 'schedule' ? `- رسايل مستنية الفحص الفوري: ${rt.realtimePending || 0}` : null,
          rt.heldAlerts ? `- تنبيهات مستنية وقت الهدوء يخلص: ${rt.heldAlerts}` : null,
          `- آخر ملخص: ${lastText}`,
          `- الموديل: ${model}`,
          `- شغال من: ${formatDuration(Date.now() - startedAt)}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },

    async clear() {
      const n = store.clear();
      await send(`🗑️ اتمسحت ${n} رسالة من غير تلخيص.`);
    },
  };

  /**
   * Runs the command in `text`, if any.
   * @returns {Promise<boolean>} true if it was a command
   */
  return async function handle(text) {
    const parsed = parseCommand(text);
    if (!parsed) return false;
    await handlers[parsed.key](parsed.args);
    return true;
  };
}

module.exports = { createCommandHandler, parseCommand, resolveChat, normalize, helpText, COMMANDS };
