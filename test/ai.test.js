'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIClient } = require('../src/ai');
const { silentLogger } = require('../src/logger');
const { noSleep } = require('./helpers');

function response(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

const ok = (content) => response(200, { choices: [{ message: { content } }] });

function client(fetchImpl, extra = {}) {
  return createAIClient({
    url: 'https://example.test/v1/chat/completions',
    key: 'k',
    model: 'm',
    fetchImpl,
    sleep: noSleep,
    logger: silentLogger,
    ...extra,
  });
}

test('sends system + user messages and returns the content', async () => {
  let sent;
  const ai = client(async (url, init) => {
    sent = { url, init };
    return ok('  summary  ');
  });
  assert.equal(await ai.ask('rules', 'text'), 'summary');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.model, 'm');
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(sent.init.headers.Authorization, 'Bearer k');
});

test('retries on 429 and then succeeds', async () => {
  const waits = [];
  let calls = 0;
  const ai = client(
    async () => (++calls < 3 ? response(429, { error: { message: 'slow down' } }, { 'retry-after': '2' }) : ok('done')),
    { sleep: async (ms) => waits.push(ms) },
  );
  assert.equal(await ai.ask('s', 'u'), 'done');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2000]);
});

test('does not retry on 401', async () => {
  let calls = 0;
  const ai = client(async () => {
    calls++;
    return response(401, { error: { message: 'bad key' } });
  });
  await assert.rejects(ai.ask('s', 'u'), /401: bad key/);
  assert.equal(calls, 1);
});

test('gives up after maxRetries', async () => {
  let calls = 0;
  const ai = client(
    async () => {
      calls++;
      return response(503, 'down');
    },
    { maxRetries: 2 },
  );
  await assert.rejects(ai.ask('s', 'u'), /503/);
  assert.equal(calls, 3);
});

test('retries network errors', async () => {
  let calls = 0;
  const ai = client(async () => {
    if (++calls === 1) throw new Error('ECONNRESET');
    return ok('fine');
  });
  assert.equal(await ai.ask('s', 'u'), 'fine');
});

test('rejects an empty answer', async () => {
  const ai = client(async () => ok(''));
  await assert.rejects(ai.ask('s', 'u'), /empty answer/);
});
