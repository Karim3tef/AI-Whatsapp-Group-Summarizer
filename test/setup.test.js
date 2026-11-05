'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { timesToCron, buildEnv } = require('../scripts/setup');
const { loadConfig } = require('../src/config');
const { randomSecret } = require('../src/crypto');

test('timesToCron', () => {
  assert.equal(timesToCron('21:00'), '0 21 * * *');
  assert.equal(timesToCron('21:00, 08:00'), '0 8,21 * * *');
  assert.equal(timesToCron('08:15,21:00'), null);
  assert.equal(timesToCron('25:00'), null);
  assert.equal(timesToCron(''), null);
});

test('buildEnv output is a valid configuration', () => {
  const text = buildEnv({
    providerName: 'Groq',
    aiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    aiKey: 'key',
    aiModel: 'model',
    chunkSize: 8000,
    chunkWait: 60000,
    mode: 'both',
    schedule: '0 21 * * *',
    timezone: 'Africa/Cairo',
    quietHours: '23:00-07:00',
    deliver: true,
    urgentKeywords: 'exam,deadline',
    encryptionKey: randomSecret(),
    apiKey: randomSecret(),
    apiHost: '127.0.0.1',
    apiPort: 3000,
    webhookUrl: 'https://example.com/hook',
    webhookSecret: randomSecret(),
  });
  const env = Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  const c = loadConfig(env);
  assert.equal(c.mode, 'both');
  assert.equal(c.api.enabled, true);
  assert.ok(c.webhook);
  assert.ok(c.encryptionKey);
  assert.ok(c.quietHours);
});
