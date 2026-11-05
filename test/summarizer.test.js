'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createSummarizer, formatTranscript } = require('../src/summarizer');
const { MessageStore, HistoryStore } = require('../src/storage');
const { silentLogger } = require('../src/logger');
const { tempDir, noSleep } = require('./helpers');

function setup(t, { ask, chunkSize = 10000 } = {}) {
  const store = new MessageStore(path.join(tempDir(t), 'm.json'));
  const sent = [];
  const calls = [];
  const ai = {
    ask: async (system, user) => {
      calls.push({ system, user });
      return ask ? ask(system, user, calls.length) : `summary ${calls.length}`;
    },
  };
  const summarizer = createSummarizer({
    store,
    ai,
    send: async (text) => sent.push(text),
    prompt: 'PROMPT',
    chunkSize,
    chunkWait: 0,
    sleep: noSleep,
    logger: silentLogger,
  });
  return { store, sent, calls, summarizer };
}

const msg = (i) => ({ group: 'G', time: '1/1', from: `user${i}`, text: `message ${i}` });

test('empty queue sends a short note', async (t) => {
  const { summarizer, sent, calls } = setup(t);
  assert.equal((await summarizer.summarize()).status, 'empty');
  assert.equal(calls.length, 0);
  assert.match(sent[0], /مفيش رسايل/);
});

test('empty queue stays quiet when asked', async (t) => {
  const { summarizer, sent } = setup(t);
  await summarizer.summarize({ quietIfEmpty: true });
  assert.equal(sent.length, 0);
});

test('single chunk: one AI call, summary sent, queue cleared', async (t) => {
  const { summarizer, store, sent, calls } = setup(t);
  store.add(msg(1));
  store.add(msg(2));
  const result = await summarizer.summarize();
  assert.equal(result.status, 'sent');
  assert.equal(result.count, 2);
  assert.equal(result.summary.text, 'summary 1');
  assert.deepEqual(result.summary.groups, ['G']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, 'PROMPT');
  assert.match(calls[0].user, /\[G\] 1\/1 - user1: message 1/);
  assert.match(sent[0], /summary 1/);
  assert.equal(store.count, 0);
});

test('many chunks are summarized then merged', async (t) => {
  const { summarizer, store, sent, calls } = setup(t, { chunkSize: 500 });
  for (let i = 0; i < 40; i++) store.add(msg(i));
  await summarizer.summarize();
  const chunkCalls = calls.length - 1;
  assert.ok(chunkCalls > 1);
  const merge = calls[calls.length - 1];
  assert.match(merge.system, /ادمج/);
  assert.match(merge.user, /summary 1/);
  assert.match(sent[0], new RegExp(`summary ${calls.length}`));
});

test('failure keeps the messages and tells the user', async (t) => {
  const { summarizer, store, sent } = setup(t, {
    ask: async () => {
      throw new Error('AI error 429: limit');
    },
  });
  store.add(msg(1));
  const result = await summarizer.summarize();
  assert.equal(result.status, 'failed');
  assert.equal(store.count, 1);
  assert.match(sent[0], /الرسايل محفوظة/);
  assert.equal(summarizer.getLastRun().status, 'failed');
});

test('messages arriving during a summary are kept', async (t) => {
  let store;
  const ctx = setup(t, {
    ask: async () => {
      store.add(msg(99));
      return 'ok';
    },
  });
  store = ctx.store;
  store.add(msg(1));
  await ctx.summarizer.summarize();
  assert.deepEqual(store.snapshot().map((m) => m.from), ['user99']);
});

test('a second call while busy is refused', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { summarizer, store, sent } = setup(t, { ask: () => gate.then(() => 'ok') });
  store.add(msg(1));
  const first = summarizer.summarize();
  assert.equal((await summarizer.summarize()).status, 'busy');
  release();
  assert.equal((await first).status, 'sent');
  assert.match(sent[0], /فيه ملخص شغال/);
});

test('deliver:false skips WhatsApp but still saves and notifies listeners', async (t) => {
  const { store } = setup(t);
  const sent = [];
  const seen = [];
  const summaries = new HistoryStore(path.join(tempDir(t), 's.json'));
  const summarizer = createSummarizer({
    store,
    summaries,
    ai: { ask: async () => 'text' },
    send: async (x) => sent.push(x),
    prompt: 'P',
    chunkSize: 1000,
    chunkWait: 0,
    deliverByDefault: () => false,
    onSummary: (s) => seen.push(s),
    sleep: noSleep,
    logger: silentLogger,
  });
  store.add(msg(1));
  const result = await summarizer.summarize();
  assert.equal(result.status, 'sent');
  assert.equal(sent.length, 0);
  assert.equal(summaries.latest().text, 'text');
  assert.equal(summaries.latest().delivered, false);
  assert.equal(seen[0].id, summaries.latest().id);
  // Nothing is sent to WhatsApp for an empty queue either.
  await summarizer.summarize();
  assert.equal(sent.length, 0);
});

test('formatTranscript flattens multi-line messages', () => {
  const out = formatTranscript([{ group: 'G', time: 't', from: 'a', text: 'line1\nline2' }]);
  assert.equal(out, '[G] t - a: line1 line2');
});
