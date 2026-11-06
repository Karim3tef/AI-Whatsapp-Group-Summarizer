'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createCommandHandler, parseCommand, resolveChat } = require('../src/commands');
const { MessageStore, GroupStore, SettingsStore, HistoryStore } = require('../src/storage');
const { tempDir } = require('./helpers');

const CHATS = [
  { id: 'b@g.us', name: 'Physics 2026' },
  { id: 'a@g.us', name: 'Algorithms' },
  { id: 'c@g.us', name: 'Physics Lab' },
];

function setup(t) {
  const dir = tempDir(t);
  const store = new MessageStore(path.join(dir, 'm.json'));
  const groups = new GroupStore(path.join(dir, 'g.json'));
  const settings = new SettingsStore(path.join(dir, 'settings.json'), { mode: 'schedule', deliverToWhatsApp: true });
  const alerts = new HistoryStore(path.join(dir, 'a.json'));
  const changes = [];
  const sent = [];
  const summarizeCalls = [];
  const handle = createCommandHandler({
    send: async (text) => sent.push(text),
    listGroupChats: async () => CHATS,
    store,
    groups,
    summarizer: { summarize: async (o) => summarizeCalls.push(o), getLastRun: () => null },
    getNextRun: () => new Date('2026-01-01T19:00:00Z'),
    model: 'test-model',
    timezone: 'Africa/Cairo',
    settings,
    alerts,
    onSettingsChange: (all) => changes.push(all),
  });
  return { handle, sent, store, groups, summarizeCalls, settings, alerts, changes };
}

test('parseCommand accepts Arabic, English and letter variants', () => {
  assert.equal(parseCommand('!ملخص').key, 'summary');
  assert.equal(parseCommand('  !Summary  ').key, 'summary');
  assert.equal(parseCommand('!إلغاء 2').key, 'unwatch');
  assert.equal(parseCommand('!الغاء 2').args, '2');
  assert.equal(parseCommand('!اوامر').key, 'help');
  assert.equal(parseCommand('!حاله').key, 'status');
  assert.equal(parseCommand('‏!جروبات').key, 'groups');
  assert.equal(parseCommand('!‏تابع‎ 3').args, '3');
  assert.equal(parseCommand('ملخص'), null);
  assert.equal(parseCommand('!unknown'), null);
  assert.equal(parseCommand(undefined), null);
});

test('resolveChat by number (sorted), exact name and unique partial name', () => {
  assert.equal(resolveChat('1', CHATS).chat.name, 'Algorithms');
  assert.equal(resolveChat('Physics Lab', CHATS).chat.id, 'c@g.us');
  assert.equal(resolveChat('algo', CHATS).chat.id, 'a@g.us');
  assert.match(resolveChat('Physics', CHATS).error, /أكتر من جروب/);
  assert.match(resolveChat('9', CHATS).error, /مفيش جروب برقم 9/);
  assert.match(resolveChat('', CHATS).error, /اكتب رقم/);
});

test('non-commands are ignored', async (t) => {
  const { handle, sent } = setup(t);
  assert.equal(await handle('hello'), false);
  assert.equal(sent.length, 0);
});

test('!ملخص runs the summarizer', async (t) => {
  const { handle, summarizeCalls } = setup(t);
  assert.equal(await handle('!ملخص'), true);
  assert.equal(summarizeCalls.length, 1);
});

test('!تابع then !جروبات marks the watched group', async (t) => {
  const { handle, sent, groups } = setup(t);
  await handle('!تابع 1');
  assert.match(sent[0], /Algorithms/);
  assert.equal(groups.count, 1);
  await handle('!جروبات');
  assert.match(sent[1], /1\. ✅ Algorithms/);
  assert.match(sent[1], /2\. Physics 2026/);
});

test('!الغي removes a group, even one no longer in the chat list', async (t) => {
  const { handle, groups } = setup(t);
  groups.add({ id: 'gone@g.us', name: 'Old Group' });
  await handle('!الغي Old Group');
  assert.equal(groups.count, 0);
});

test('!حالة reports counts and model', async (t) => {
  const { handle, sent, store } = setup(t);
  store.add({ text: 'x' });
  await handle('!حالة');
  assert.match(sent[0], /رسايل مستنية التلخيص: 1/);
  assert.match(sent[0], /test-model/);
});

test('!مسح clears pending messages', async (t) => {
  const { handle, sent, store } = setup(t);
  store.add({ text: 'x' });
  store.add({ text: 'y' });
  await handle('!مسح');
  assert.equal(store.count, 0);
  assert.match(sent[0], /2 رسالة/);
});

test('!مساعدة lists the commands', async (t) => {
  const { handle, sent } = setup(t);
  await handle('!help');
  assert.match(sent[0], /!ملخص/);
  assert.match(sent[0], /!تابع/);
});

test('!وضع shows and changes the mode', async (t) => {
  const { handle, sent, settings, changes } = setup(t);
  await handle('!وضع');
  assert.match(sent[0], /الوضع الحالي: \*مجدول\*/);
  await handle('!وضع فوري');
  assert.equal(settings.get('mode'), 'realtime');
  assert.equal(changes[0].mode, 'realtime');
  await handle('!mode both');
  assert.equal(settings.get('mode'), 'both');
  await handle('!وضع حاجة');
  assert.match(sent[sent.length - 1], /مش فاهم/);
});

test('!تنبيهات lists recent alerts', async (t) => {
  const { handle, sent, alerts } = setup(t);
  await handle('!تنبيهات');
  assert.match(sent[0], /مفيش تنبيهات/);
  alerts.add({ group: 'G', text: 'Exam moved to Sunday', urgent: true });
  await handle('!alerts');
  assert.match(sent[1], /⚠️ \*G\*/);
  assert.match(sent[1], /Exam moved to Sunday/);
});
