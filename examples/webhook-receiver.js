#!/usr/bin/env node
'use strict';

/**
 * Example: receive webhooks from the summarizer in another project and check
 * they are genuine (Node 18+, no dependencies).
 *
 *   WEBHOOK_SECRET=<same secret as the bot> node examples/webhook-receiver.js
 *
 * Then set in the bot's .env:  WEBHOOK_URL=http://localhost:4000/hooks/summary
 * (in production use https://).
 */

const http = require('http');
const crypto = require('crypto');

const SECRET = process.env.WEBHOOK_SECRET;
const PORT = Number(process.env.PORT || 4000);
if (!SECRET) {
  console.error('Set WEBHOOK_SECRET to the same value as in the bot .env');
  process.exit(1);
}

/** Signature = HMAC-SHA256("<timestamp>.<raw body>"), rejected if older than 5 minutes. */
function isGenuine(rawBody, timestamp, signature) {
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const seen = new Set(); // delivery IDs already handled (retries reuse the same ID)

http
  .createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hooks/summary') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!isGenuine(raw, req.headers['x-summarizer-timestamp'], req.headers['x-summarizer-signature'])) {
        res.writeHead(401).end();
        return;
      }
      const event = JSON.parse(raw);
      res.writeHead(204).end(); // answer fast, then do the work

      if (seen.has(event.id)) return;
      seen.add(event.id);

      if (event.event === 'summary.created') {
        console.log(`New summary (${event.data.messageCount} messages):\n${event.data.text}\n`);
        // e.g. save to your database / show on your dashboard
      } else if (event.event === 'alert.created') {
        console.log(`Alert${event.data.urgent ? ' [URGENT]' : ''} — ${event.data.group}: ${event.data.text}`);
      }
    });
  })
  .listen(PORT, () => console.log(`Webhook receiver on http://localhost:${PORT}/hooks/summary`));
