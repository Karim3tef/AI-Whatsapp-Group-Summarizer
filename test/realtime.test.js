'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRealtimeWatcher, parseAlerts } = require('../src/realtime');
const { createNotifier } = require('../src/notifier');
const { parseMode, parseQuietHours, isQuiet } = require('../src/modes');
const { formatAlerts } = require('../src/bot');
const { silentLogger } = require('../src/logger');

const msg = (text) => ({ group: 'G', time: 't', from: 'a', text });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('parseAlerts reads JSON even inside extra text or code fences', () => {
  const answer = 'Here:\n```json\n{"alerts":[{"group":"G","text":"Quiz Sunday","urgent":true},{"text":"  "}]}\n```';
  assert.deepEqual(parseAlerts(answer), [{ group: 'G', text: 'Quiz Sunday', urgent: true }]);
  assert.deepEqual(parseAlerts('{"alerts":[]}'), []);
  assert.throws(() => parseAlerts('no json here'), /no JSON/);
});

test('watcher batches messages into one AI call after the quiet period', async () => {
  const calls = [];
  const raised = [];
  const watcher = createRealtimeWatcher({
    ai: {
      ask: async (system, user) => {
        calls.push(user);
        return '{"alerts":[{"group":"G","text":"Deadline moved","urgent":false}]}';
      },
    },
    prompt: 'P',
    debounceMs: 30,
    maxWaitMs: 1000,
    chunkSize: 10000,
    onAlerts: (alerts) => raised.push(...alerts),
    logger: silentLogger,
  });
  watcher.push(msg('one'));
  watcher.push(msg('two'));
  assert.equal(watcher.pending(), 2);
  await wait(80);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /one[\s\S]*two/);
  assert.equal(raised[0].text, 'Deadline moved');
  assert.equal(watcher.getLastCheck().alerts, 1);
  watcher.stop();
});

test('watcher fires by maxWait even if messages keep coming', async () => {
  let calls = 0;
  const watcher = createRealtimeWatcher({
    ai: { ask: async () => (calls++, '{"alerts":[]}') },
    prompt: 'P',
    debounceMs: 50,
    maxWaitMs: 60,
    chunkSize: 10000,
    onAlerts: () => {},
    logger: silentLogger,
  });
  for (let i = 0; i < 6; i++) {
    watcher.push(msg(String(i)));
    await wait(15);
  }
  await wait(70);
  assert.ok(calls >= 1);
  watcher.stop();
});

test('watcher survives AI errors and bad JSON', async () => {
  const watcher = createRealtimeWatcher({
    ai: { ask: async () => 'not json' },
    prompt: 'P',
    debounceMs: 1000,
    maxWaitMs: 1000,
    chunkSize: 10000,
    onAlerts: () => assert.fail('no alerts expected'),
    logger: silentLogger,
  });
  watcher.push(msg('x'));
  assert.deepEqual(await watcher.flush(), []);
  assert.match(watcher.getLastCheck().error, /no JSON/);
  watcher.stop();
});

test('parseMode accepts English and Arabic', () => {
  assert.equal(parseMode('realtime'), 'realtime');
  assert.equal(parseMode('فوري'), 'realtime');
  assert.equal(parseMode('مجدول'), 'schedule');
  assert.equal(parseMode('الاتنين'), 'both');
  assert.equal(parseMode('x'), null);
});

test('quiet hours work across midnight and in the given time zone', () => {
  const q = parseQuietHours('23:00-07:00');
  // 22:00 and 01:00 UTC -> Cairo (UTC+2 in Nov 2026) is 00:00 and 03:00.
  assert.equal(isQuiet(q, 'UTC', new Date('2026-11-05T23:30:00Z')), true);
  assert.equal(isQuiet(q, 'UTC', new Date('2026-11-05T12:00:00Z')), false);
  assert.equal(isQuiet(q, 'Africa/Cairo', new Date('2026-11-05T22:00:00Z')), true);
  const day = parseQuietHours('13:00-14:00');
  assert.equal(isQuiet(day, 'UTC', new Date('2026-11-05T13:30:00Z')), true);
  assert.equal(isQuiet(day, 'UTC', new Date('2026-11-05T14:00:00Z')), false);
  assert.equal(parseQuietHours('25:00-07:00'), null);
  assert.equal(isQuiet(null, 'UTC'), false);
});

test('notifier holds alerts during quiet hours and sends them after', async () => {
  const sent = [];
  let now = new Date('2026-11-05T23:30:00Z');
  const n = createNotifier({
    send: async (t) => sent.push(t),
    quietHours: parseQuietHours('23:00-07:00'),
    timezone: 'UTC',
    logger: silentLogger,
    now: () => now,
  });
  assert.equal(await n.notify('later', { holdable: true }), 'held');
  assert.equal(await n.notify('urgent now'), 'sent');
  assert.equal(await n.flushHeld(), 0);
  now = new Date('2026-11-06T07:05:00Z');
  assert.equal(await n.flushHeld(), 1);
  assert.match(sent[1], /later/);
  assert.equal(n.heldCount(), 0);
  n.stop();
});

test('formatAlerts groups alerts by group and marks urgent ones', () => {
  const text = formatAlerts([
    { group: 'A', text: 'one', urgent: true },
    { group: 'B', text: 'two', urgent: false },
    { group: 'A', text: 'three', urgent: false },
  ]);
  assert.match(text, /\*A\*\n⚠️ one\n- three/);
  assert.match(text, /\*B\*\n- two/);
});
