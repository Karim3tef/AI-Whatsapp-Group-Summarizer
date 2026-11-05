'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { createApiServer } = require('../src/api');
const { MessageStore, GroupStore, HistoryStore, SettingsStore } = require('../src/storage');
const { silentLogger } = require('../src/logger');
const { tempDir } = require('./helpers');

const KEY = 'k'.repeat(64);
const CHATS = [
  { id: 'a@g.us', name: 'Team' },
  { id: 'b@g.us', name: 'Course' },
];

async function setup(t, apiOverrides = {}) {
  const dir = tempDir(t);
  const store = new MessageStore(path.join(dir, 'm.json'));
  const groups = new GroupStore(path.join(dir, 'g.json'));
  const summaries = new HistoryStore(path.join(dir, 's.json'));
  const alerts = new HistoryStore(path.join(dir, 'a.json'));
  const settings = new SettingsStore(path.join(dir, 'settings.json'), { mode: 'schedule', deliverToWhatsApp: true });
  const bus = new EventEmitter();
  const state = { ready: true, busy: false, calls: [] };

  const summarizer = {
    isBusy: () => state.busy,
    getLastRun: () => null,
    async summarize(options) {
      state.calls.push(options);
      if (!store.count) return { status: 'empty' };
      const summary = summaries.add({ text: 'S', messageCount: store.count, groups: ['Team'] });
      store.clear();
      return { status: 'sent', count: 1, summary };
    },
  };

  const api = createApiServer({
    apiConfig: {
      host: '127.0.0.1',
      port: 0,
      keys: [KEY],
      trustProxy: false,
      corsOrigins: ['https://dash.example.com'],
      rateLimit: 1000,
      allowRawMessages: false,
      ...apiOverrides,
    },
    store,
    groups,
    summaries,
    alerts,
    settings,
    bus,
    getRuntime: () => ({ realtimePending: 0, heldAlerts: 0 }),
    summarizer,
    listGroupChats: async () => CHATS,
    isReady: () => state.ready,
    getNextRun: () => null,
    info: { version: '1.0.0', model: 'm', schedule: '0 21 * * *', timezone: 'UTC', quietHours: null },
    logger: silentLogger,
  });
  const port = await api.listen();
  t.after(() => api.close());

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, url, { body, key = KEY, headers = {} } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
  return { call, base, store, groups, summaries, alerts, settings, bus, state };
}

test('health is public and reveals nothing sensitive', async (t) => {
  const { call } = await setup(t);
  const r = await call('GET', '/health', { key: null });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'ok', whatsapp: 'ready' });
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('every /v1 route needs a valid key (Bearer or X-API-Key)', async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('GET', '/v1/status', { key: null })).status, 401);
  assert.equal((await call('GET', '/v1/status', { key: 'wrong' })).status, 401);
  assert.equal((await call('GET', '/v1/status')).status, 200);
  const viaHeader = await call('GET', '/v1/status', { key: null, headers: { 'X-API-Key': KEY } });
  assert.equal(viaHeader.status, 200);
});

test('repeated bad keys lock the client out', async (t) => {
  const { call } = await setup(t);
  for (let i = 0; i < 10; i++) await call('GET', '/v1/status', { key: 'bad' });
  const r = await call('GET', '/v1/status');
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, 'too_many_auth_failures');
});

test('rate limit returns 429 with Retry-After', async (t) => {
  const { call } = await setup(t, { rateLimit: 2 });
  await call('GET', '/health');
  await call('GET', '/health');
  const r = await call('GET', '/health');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});

test('groups: list, watch, unwatch', async (t) => {
  const { call, groups } = await setup(t);
  const list = await call('GET', '/v1/groups');
  assert.deepEqual(list.json.groups.map((g) => g.watched), [false, false]);

  const add = await call('POST', '/v1/groups/watched', { body: { name: 'Team' } });
  assert.equal(add.status, 201);
  assert.equal((await call('POST', '/v1/groups/watched', { body: { id: 'a@g.us' } })).status, 200);
  assert.equal((await call('POST', '/v1/groups/watched', { body: { name: 'Nope' } })).status, 404);
  assert.equal((await call('POST', '/v1/groups/watched', { body: {} })).status, 400);
  assert.equal(groups.count, 1);

  const del = await call('DELETE', `/v1/groups/watched/${encodeURIComponent('a@g.us')}`);
  assert.equal(del.status, 200);
  assert.equal(groups.count, 0);
  assert.equal((await call('DELETE', '/v1/groups/watched/a%40g.us')).status, 404);
});

test('groups need WhatsApp to be connected', async (t) => {
  const { call, state } = await setup(t);
  state.ready = false;
  const r = await call('GET', '/v1/groups');
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'whatsapp_not_ready');
});

test('pending messages: counts by default, raw text only when allowed', async (t) => {
  const { call, store } = await setup(t);
  store.add({ group: 'Team', text: 'private' });
  const r = await call('GET', '/v1/messages/pending');
  assert.deepEqual(r.json, { count: 1, byGroup: { Team: 1 } });
  assert.equal((await call('GET', '/v1/messages/pending?include=messages')).status, 403);
  assert.equal((await call('DELETE', '/v1/messages/pending')).json.cleared, 1);
});

test('raw messages can be exposed when API_ALLOW_RAW_MESSAGES is on', async (t) => {
  const { call, store } = await setup(t, { allowRawMessages: true });
  store.add({ group: 'Team', text: 'hello' });
  const r = await call('GET', '/v1/messages/pending?include=messages');
  assert.equal(r.json.messages[0].text, 'hello');
});

test('summaries: trigger (wait), list, latest, by id', async (t) => {
  const { call, store, state } = await setup(t);
  assert.equal((await call('GET', '/v1/summaries/latest')).status, 404);

  const empty = await call('POST', '/v1/summaries', { body: { wait: true } });
  assert.equal(empty.json.status, 'empty');

  store.add({ group: 'Team', text: 'x' });
  const created = await call('POST', '/v1/summaries', { body: { wait: true, deliver: false } });
  assert.equal(created.status, 201);
  assert.equal(state.calls[1].deliver, false);
  const id = created.json.summary.id;

  assert.equal((await call('GET', '/v1/summaries')).json.summaries.length, 1);
  assert.equal((await call('GET', '/v1/summaries/latest')).json.summary.id, id);
  assert.equal((await call('GET', `/v1/summaries/${id}`)).json.summary.text, 'S');
  assert.equal((await call('GET', '/v1/summaries/unknown')).status, 404);
});

test('summaries: async trigger, busy and validation', async (t) => {
  const { call, state } = await setup(t);
  assert.equal((await call('POST', '/v1/summaries')).status, 202);
  assert.equal((await call('POST', '/v1/summaries', { body: { deliver: 'yes' } })).status, 400);
  state.busy = true;
  assert.equal((await call('POST', '/v1/summaries')).status, 409);
});

test('settings: read and update mode', async (t) => {
  const { call, settings, bus } = await setup(t);
  const events = [];
  bus.on('settings.updated', (s) => events.push(s));
  assert.equal((await call('GET', '/v1/settings')).json.settings.mode, 'schedule');
  const r = await call('PATCH', '/v1/settings', { body: { mode: 'realtime' } });
  assert.equal(r.json.settings.mode, 'realtime');
  assert.equal(settings.get('mode'), 'realtime');
  assert.equal(events[0].mode, 'realtime');
  assert.equal((await call('PATCH', '/v1/settings', { body: { mode: 'x' } })).status, 400);
  assert.equal((await call('PATCH', '/v1/settings', { body: { other: 1 } })).status, 400);
});

test('alerts list', async (t) => {
  const { call, alerts } = await setup(t);
  alerts.add({ group: 'Team', text: 'Meeting moved', urgent: true });
  const r = await call('GET', '/v1/alerts');
  assert.equal(r.json.alerts[0].text, 'Meeting moved');
});

test('bad input is rejected cleanly', async (t) => {
  const { base, call } = await setup(t);
  const notJson = await fetch(`${base}/v1/summaries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(notJson.status, 415);
  const broken = await fetch(`${base}/v1/summaries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: '{bad',
  });
  assert.equal(broken.status, 400);
  const huge = await fetch(`${base}/v1/summaries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: 'a'.repeat(20000) }),
  }).catch(() => ({ status: 413 }));
  assert.equal(huge.status, 413);
  assert.equal((await call('GET', '/v1/nothing')).status, 404);
  assert.equal((await call('PUT', '/v1/status')).status, 405);
});

test('CORS only for allowed origins', async (t) => {
  const { call } = await setup(t);
  const ok = await call('GET', '/v1/status', { headers: { Origin: 'https://dash.example.com' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://dash.example.com');
  const no = await call('GET', '/v1/status', { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('live stream delivers new events', async (t) => {
  const { base, bus } = await setup(t);
  const controller = new AbortController();
  const res = await fetch(`${base}/v1/stream`, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  text += decoder.decode((await reader.read()).value);
  bus.emit('alert.created', { id: '1', text: 'Exam moved' });
  while (!text.includes('Exam moved')) text += decoder.decode((await reader.read()).value);
  assert.match(text, /event: alert.created\ndata: \{"id":"1","text":"Exam moved"\}/);
  controller.abort();
});

test('stream requires a key', async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('GET', '/v1/stream', { key: null })).status, 401);
});
