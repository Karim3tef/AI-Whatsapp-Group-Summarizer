'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { messageText, clearChromiumLocks } = require('../src/bot');

test('messageText keeps plain text', () => {
  assert.equal(messageText({ body: ' hi ', type: 'chat' }), 'hi');
});

test('messageText labels media with and without caption', () => {
  assert.equal(messageText({ body: '', hasMedia: true, type: 'image' }), '[بعت image]');
  assert.equal(messageText({ body: 'slides', hasMedia: true, type: 'document' }), '[document] slides');
});

test('messageText ignores empty system messages', () => {
  assert.equal(messageText({ body: '', type: 'notification_template' }), '');
});

test('clearChromiumLocks removes stale locks and keeps the session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-'));
  const profile = path.join(dir, 'session');
  fs.mkdirSync(profile);
  // Chromium writes the lock as a symlink to "<host>-<pid>" that does not exist.
  fs.symlinkSync('old-host-16', path.join(profile, 'SingletonLock'));
  fs.writeFileSync(path.join(profile, 'Local State'), '{}');

  clearChromiumLocks(dir);
  assert.equal(fs.readdirSync(profile).join(), 'Local State');
  clearChromiumLocks(path.join(dir, 'missing')); // no session yet: no error
  fs.rmSync(dir, { recursive: true });
});
