'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MessageStore, GroupStore } = require('../src/storage');
const { silentLogger } = require('../src/logger');
const { tempDir } = require('./helpers');

test('MessageStore persists across instances', (t) => {
  const file = path.join(tempDir(t), 'data', 'messages.json');
  const a = new MessageStore(file);
  a.add({ text: 'one' });
  a.add({ text: 'two' });
  const b = new MessageStore(file);
  assert.equal(b.count, 2);
  assert.equal(b.snapshot()[1].text, 'two');
});

test('MessageStore.removeFirst keeps messages that arrived later', (t) => {
  const store = new MessageStore(path.join(tempDir(t), 'm.json'));
  store.add({ text: '1' });
  store.add({ text: '2' });
  const batch = store.snapshot();
  store.add({ text: '3' });
  store.removeFirst(batch.length);
  assert.deepEqual(store.snapshot().map((m) => m.text), ['3']);
});

test('MessageStore drops oldest when full', (t) => {
  const store = new MessageStore(path.join(tempDir(t), 'm.json'), { maxStored: 2, logger: silentLogger });
  ['1', '2', '3'].forEach((text) => store.add({ text }));
  assert.deepEqual(store.snapshot().map((m) => m.text), ['2', '3']);
});

test('MessageStore survives a corrupt file', (t) => {
  const file = path.join(tempDir(t), 'm.json');
  fs.writeFileSync(file, '{not json');
  const store = new MessageStore(file, { logger: silentLogger });
  assert.equal(store.count, 0);
});

test('MessageStore writes private files', (t) => {
  if (process.platform === 'win32') return t.skip('no POSIX modes');
  const file = path.join(tempDir(t), 'm.json');
  new MessageStore(file).add({ text: 'x' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('GroupStore seeds from initial names only on first run', (t) => {
  const file = path.join(tempDir(t), 'g.json');
  const a = new GroupStore(file, { initialGroups: ['A', 'B'] });
  assert.equal(a.count, 2);
  a.remove({ name: 'A' });
  const b = new GroupStore(file, { initialGroups: ['A', 'B'] });
  assert.deepEqual(b.list().map((g) => g.name), ['B']);
});

test('GroupStore.matches fills the ID and follows renames', (t) => {
  const file = path.join(tempDir(t), 'g.json');
  const groups = new GroupStore(file, { initialGroups: ['Old name'] });
  assert.equal(groups.matches({ id: 'g1@g.us', name: 'Other' }), false);
  assert.equal(groups.matches({ id: 'g1@g.us', name: 'Old name' }), true);
  assert.equal(groups.list()[0].id, 'g1@g.us');
  // Renamed group is still matched by ID.
  assert.equal(groups.matches({ id: 'g1@g.us', name: 'New name' }), true);
  assert.equal(new GroupStore(file).list()[0].name, 'New name');
});

test('GroupStore add/remove report changes', (t) => {
  const groups = new GroupStore(path.join(tempDir(t), 'g.json'));
  const chat = { id: 'x@g.us', name: 'X' };
  assert.equal(groups.add(chat), true);
  assert.equal(groups.add(chat), false);
  assert.equal(groups.isWatched(chat), true);
  assert.equal(groups.remove(chat), true);
  assert.equal(groups.remove(chat), false);
});

const { HistoryStore, SettingsStore, JsonFile } = require('../src/storage');
const { randomSecret, parseKey } = require('../src/crypto');

test('encrypted files are unreadable without the key and round-trip with it', (t) => {
  const file = path.join(tempDir(t), 'm.json');
  const key = parseKey(randomSecret());
  new MessageStore(file, { encryptionKey: key }).add({ text: 'secret exam date' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('secret exam date'));
  assert.equal(JSON.parse(raw).alg, 'aes-256-gcm');
  assert.equal(new MessageStore(file, { encryptionKey: key }).snapshot()[0].text, 'secret exam date');
  assert.throws(() => new MessageStore(file), /DATA_ENCRYPTION_KEY is not set/);
  assert.throws(() => new MessageStore(file, { encryptionKey: parseKey(randomSecret()) }), /wrong DATA_ENCRYPTION_KEY/);
});

test('a plain file is migrated to encrypted on next write', (t) => {
  const file = path.join(tempDir(t), 'm.json');
  new MessageStore(file).add({ text: 'old' });
  const key = parseKey(randomSecret());
  const store = new MessageStore(file, { encryptionKey: key });
  assert.equal(store.count, 1);
  store.add({ text: 'new' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).encrypted, true);
});

test('a corrupt file is moved aside, not overwritten', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, '{oops');
  assert.deepEqual(new JsonFile(file, { logger: silentLogger }).read([]), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('x.json.corrupt-')));
});

test('HistoryStore keeps the newest N, newest first', (t) => {
  const file = path.join(tempDir(t), 'h.json');
  const h = new HistoryStore(file, { limit: 2 });
  const a = h.add({ text: 'a' });
  h.add({ text: 'b' });
  h.add({ text: 'c' });
  assert.deepEqual(h.list().map((x) => x.text), ['c', 'b']);
  assert.equal(h.get(a.id), null);
  assert.equal(new HistoryStore(file, { limit: 2 }).latest().text, 'c');
});

test('HistoryStore with limit 0 stores nothing', (t) => {
  const file = path.join(tempDir(t), 'h.json');
  const item = new HistoryStore(file, { limit: 0 }).add({ text: 'a' });
  assert.ok(item.id);
  assert.equal(fs.existsSync(file), false);
});

test('SettingsStore falls back to defaults and persists overrides', (t) => {
  const file = path.join(tempDir(t), 's.json');
  const s = new SettingsStore(file, { mode: 'schedule', deliverToWhatsApp: true });
  assert.equal(s.get('mode'), 'schedule');
  s.set('mode', 'realtime');
  const again = new SettingsStore(file, { mode: 'schedule', deliverToWhatsApp: true });
  assert.deepEqual(again.all(), { mode: 'realtime', deliverToWhatsApp: true });
});
