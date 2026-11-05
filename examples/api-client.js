#!/usr/bin/env node
'use strict';

/**
 * Example: use the summarizer from another Node.js project (Node 18+, no
 * dependencies). Copy this file into your dashboard's backend.
 *
 *   SUMMARIZER_URL=http://127.0.0.1:3000 SUMMARIZER_KEY=<API key> node examples/api-client.js
 *
 * Keep the API key on your server. Never put it in browser code.
 */

const BASE = process.env.SUMMARIZER_URL || 'http://127.0.0.1:3000';
const KEY = process.env.SUMMARIZER_KEY;
if (!KEY) {
  console.error('Set SUMMARIZER_KEY to one of the API_KEYS from the bot .env');
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data && data.error ? data.error.message : ''}`);
  return data;
}

/** Live feed: calls onEvent(name, data) for every new summary / alert. */
async function stream(onEvent) {
  const res = await fetch(`${BASE}/v1/stream`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`stream -> ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block);
      const data = /^data: (.+)$/m.exec(block);
      if (event && data) onEvent(event[1], JSON.parse(data[1]));
    }
  }
}

async function main() {
  const status = await api('GET', '/v1/status');
  console.log('Status:', status);

  const { summaries } = await api('GET', '/v1/summaries?limit=3');
  console.log(`\nLast ${summaries.length} summaries:`);
  for (const s of summaries) console.log(`- ${s.createdAt} (${s.messageCount} msgs)\n${s.text}\n`);

  const { alerts } = await api('GET', '/v1/alerts?limit=5');
  console.log(`Last ${alerts.length} alerts:`);
  for (const a of alerts) console.log(`- ${a.urgent ? '[URGENT] ' : ''}${a.group}: ${a.text}`);

  // Ask for a fresh summary without sending it to WhatsApp, and wait for it:
  // const { summary } = await api('POST', '/v1/summaries', { deliver: false, wait: true });

  console.log('\nListening for new summaries and alerts (Ctrl+C to stop)...');
  await stream((event, data) => console.log(`[${event}]`, data.text || data));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
