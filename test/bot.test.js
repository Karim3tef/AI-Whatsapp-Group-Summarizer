'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { messageText } = require('../src/bot');

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
