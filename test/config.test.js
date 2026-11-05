'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { DEFAULT_PROMPT } = require('../src/prompt');
const { tempDir } = require('./helpers');

const BASE = { AI_URL: 'https://x/v1/chat/completions', AI_KEY: 'k', AI_MODEL: 'm' };

test('applies defaults', () => {
  const c = loadConfig(BASE);
  assert.equal(c.schedule, '0 21 * * *');
  assert.equal(c.timezone, 'Africa/Cairo');
  assert.equal(c.chunkSize, 8000);
  assert.equal(c.chunkWait, 60000);
  assert.equal(c.prompt, DEFAULT_PROMPT);
  assert.deepEqual(c.initialGroups, []);
  assert.deepEqual(c.urgentKeywords, []);
  assert.ok(c.messagesFile.endsWith(path.join('data', 'messages.json')));
});

test('parses lists', () => {
  const c = loadConfig({ ...BASE, GROUPS: ' Group A | Group, B |', URGENT_KEYWORDS: 'امتحان, تسليم ,' });
  assert.deepEqual(c.initialGroups, ['Group A', 'Group, B']);
  assert.deepEqual(c.urgentKeywords, ['امتحان', 'تسليم']);
});

test('reports every problem at once', () => {
  try {
    loadConfig({ SCHEDULE: 'nope', TIMEZONE: 'Mars/Base', CHUNK_SIZE: 'abc' });
    assert.fail('should throw');
  } catch (err) {
    const text = err.problems.join('\n');
    for (const word of ['AI_URL', 'AI_KEY', 'AI_MODEL', 'SCHEDULE', 'TIMEZONE', 'CHUNK_SIZE']) {
      assert.match(text, new RegExp(word));
    }
  }
});

test('loads a custom prompt file', (t) => {
  const file = path.join(tempDir(t), 'prompt.txt');
  fs.writeFileSync(file, 'Custom rules\n');
  assert.equal(loadConfig({ ...BASE, PROMPT_FILE: file }).prompt, 'Custom rules');
});

const KEY = 'a'.repeat(64);

test('API needs strong keys when enabled', () => {
  assert.throws(() => loadConfig({ ...BASE, API_ENABLED: 'true' }), /API_KEYS/);
  assert.throws(() => loadConfig({ ...BASE, API_ENABLED: 'true', API_KEYS: 'short' }), /at least 32/);
  const c = loadConfig({ ...BASE, API_ENABLED: 'true', API_KEYS: `${KEY},${'b'.repeat(40)}` });
  assert.equal(c.api.enabled, true);
  assert.equal(c.api.host, '127.0.0.1');
  assert.equal(c.api.keys.length, 2);
  assert.equal(c.api.allowRawMessages, false);
});

test('webhook must be https (except localhost) and signed', () => {
  assert.throws(() => loadConfig({ ...BASE, WEBHOOK_URL: 'http://example.com/h', WEBHOOK_SECRET: KEY }), /https/);
  assert.throws(() => loadConfig({ ...BASE, WEBHOOK_URL: 'https://example.com/h' }), /WEBHOOK_SECRET/);
  assert.ok(loadConfig({ ...BASE, WEBHOOK_URL: 'http://localhost:4000/h', WEBHOOK_SECRET: KEY }).webhook);
  assert.equal(loadConfig(BASE).webhook, null);
});

test('encryption key is validated', () => {
  assert.throws(() => loadConfig({ ...BASE, DATA_ENCRYPTION_KEY: 'abc' }), /DATA_ENCRYPTION_KEY/);
  assert.equal(loadConfig({ ...BASE, DATA_ENCRYPTION_KEY: KEY }).encryptionKey.length, 32);
});

test('mode and quiet hours', () => {
  const c = loadConfig({ ...BASE, MODE: 'both', QUIET_HOURS: '23:00-07:00' });
  assert.equal(c.mode, 'both');
  assert.deepEqual([c.quietHours.start, c.quietHours.end], [1380, 420]);
  assert.match(c.realtime.prompt, /alerts/);
  assert.throws(() => loadConfig({ ...BASE, MODE: 'sometimes' }), /MODE/);
  assert.throws(() => loadConfig({ ...BASE, QUIET_HOURS: 'night' }), /QUIET_HOURS/);
  assert.throws(() => loadConfig({ ...BASE, API_ENABLED: 'maybe' }), /true or false/);
});
