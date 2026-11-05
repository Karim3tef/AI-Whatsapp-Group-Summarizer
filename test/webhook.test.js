'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebhook, verifyWebhookSignature } = require('../src/webhook');
const { silentLogger } = require('../src/logger');
const { noSleep } = require('./helpers');

const SECRET = 's'.repeat(64);

test('webhook signs the payload so the receiver can verify it', async () => {
  let got;
  const hook = createWebhook({
    url: 'https://example.test/hook',
    secret: SECRET,
    fetchImpl: async (url, init) => {
      got = init;
      return new Response(null, { status: 204 });
    },
    sleep: noSleep,
    logger: silentLogger,
  });
  assert.equal(await hook.deliver('summary.created', { text: 'hi' }), true);
  const h = got.headers;
  assert.equal(h['X-Summarizer-Event'], 'summary.created');
  assert.equal(got.redirect, 'manual');
  const ok = verifyWebhookSignature({
    secret: SECRET,
    body: got.body,
    timestamp: h['X-Summarizer-Timestamp'],
    signature: h['X-Summarizer-Signature'],
  });
  assert.equal(ok, true);
  assert.equal(JSON.parse(got.body).data.text, 'hi');

  // Tampered body, wrong secret or old timestamp are rejected.
  const base = { body: got.body, timestamp: h['X-Summarizer-Timestamp'], signature: h['X-Summarizer-Signature'] };
  assert.equal(verifyWebhookSignature({ ...base, secret: SECRET, body: got.body + ' ' }), false);
  assert.equal(verifyWebhookSignature({ ...base, secret: 'x'.repeat(64) }), false);
  assert.equal(verifyWebhookSignature({ ...base, secret: SECRET, timestamp: '1000' }), false);
});

test('webhook retries server errors but not client errors', async () => {
  let calls = 0;
  const flaky = createWebhook({
    url: 'https://example.test/hook',
    secret: SECRET,
    fetchImpl: async () => new Response('', { status: ++calls < 3 ? 503 : 200 }),
    sleep: noSleep,
    logger: silentLogger,
  });
  assert.equal(await flaky.deliver('e', {}), true);
  assert.equal(calls, 3);

  calls = 0;
  const rejected = createWebhook({
    url: 'https://example.test/hook',
    secret: SECRET,
    fetchImpl: async () => (calls++, new Response('', { status: 400 })),
    sleep: noSleep,
    logger: silentLogger,
  });
  assert.equal(await rejected.deliver('e', {}), false);
  assert.equal(calls, 1);
});
