'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitText } = require('../src/chunker');

test('short text stays in one chunk', () => {
  assert.deepEqual(splitText('a\nb\nc', 100), ['a\nb\nc']);
});

test('splits on line boundaries and never exceeds size', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line number ${i}`);
  const chunks = splitText(lines.join('\n'), 60);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 60, `chunk too long: ${c.length}`);
  assert.deepEqual(chunks.join('\n').split('\n'), lines);
});

test('hard-splits a single line longer than size', () => {
  const chunks = splitText('x'.repeat(250), 100);
  assert.equal(chunks.join(''), 'x'.repeat(250));
  for (const c of chunks) assert.ok(c.length <= 100);
});

test('empty text gives no chunks', () => {
  assert.deepEqual(splitText('', 100), []);
});

test('rejects invalid size', () => {
  assert.throws(() => splitText('a', 0));
});
