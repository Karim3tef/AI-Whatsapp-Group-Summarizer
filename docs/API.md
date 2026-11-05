# HTTP API & Webhooks

The API is **optional**. Your WhatsApp "Message yourself" chat keeps working
exactly the same whether it is on or off. Turn it on when you want a dashboard
or another project to read summaries, get alerts live, or manage the bot.

- [Turning it on](#turning-it-on)
- [Authentication](#authentication)
- [Routes](#routes)
- [Live stream (Server-Sent Events)](#live-stream-server-sent-events)
- [Webhooks](#webhooks)
- [Exposing the API safely](#exposing-the-api-safely)
- [Errors and limits](#errors-and-limits)
- [Data shapes](#data-shapes)

---

## Turning it on

The setup wizard does it for you (`npm run setup`). By hand, in `.env`:

```env
API_ENABLED=true
API_HOST=127.0.0.1        # this machine only (default)
API_PORT=3000
API_KEYS=<64 hex chars>   # npm run secret
```

Restart the bot. The log prints `API listening on http://127.0.0.1:3000`.

Several keys can be listed (`API_KEYS=key1,key2`) so you can give each project
its own key and rotate them without downtime: add the new key, update the
client, remove the old key.

## Authentication

Every route except `/health` needs a key, sent in one of these headers:

```http
Authorization: Bearer <API key>
X-API-Key: <API key>
```

- Keys are compared in constant time.
- 10 wrong keys from one IP within 15 minutes lock that IP out for the rest of
  the window (`429 too_many_auth_failures`).
- **Never put the key in browser JavaScript.** Call the API from your
  dashboard's backend, or through your own server-side proxy.

## Routes

Base URL: `http://127.0.0.1:3000` (or your HTTPS domain).

| Method | Path | What it does |
|---|---|---|
| `GET` | `/health` | Public. `{"status":"ok","whatsapp":"ready"\|"connecting"}` |
| `GET` | `/v1/status` | Mode, pending messages, watched groups, next run, last run, model, uptime |
| `GET` | `/v1/settings` | Current live settings |
| `PATCH` | `/v1/settings` | Change `mode` (`schedule`/`realtime`/`both`) and/or `deliverToWhatsApp` |
| `GET` | `/v1/groups` | All groups on the account, each with `watched: true/false` (needs WhatsApp connected) |
| `GET` | `/v1/groups/watched` | Watched groups only |
| `POST` | `/v1/groups/watched` | Watch a group: `{"id": "...@g.us"}` or `{"name": "Exact name"}` |
| `DELETE` | `/v1/groups/watched/{id or name}` | Stop watching (URL-encode the value) |
| `GET` | `/v1/messages/pending` | `{count, byGroup}`. Add `?include=messages` for raw text (only if `API_ALLOW_RAW_MESSAGES=true`) |
| `DELETE` | `/v1/messages/pending` | Drop pending messages without summarizing |
| `POST` | `/v1/summaries` | Make a summary now. Body (optional): `{"deliver": false, "wait": true}` |
| `GET` | `/v1/summaries?limit=10` | Past summaries, newest first (max 100) |
| `GET` | `/v1/summaries/latest` | The newest summary |
| `GET` | `/v1/summaries/{id}` | One summary |
| `GET` | `/v1/alerts?limit=20` | Past real-time alerts, newest first (max 100) |
| `GET` | `/v1/stream` | Live events, see below |

### `POST /v1/summaries`

| Field | Default | Meaning |
|---|---|---|
| `deliver` | `DELIVER_TO_WHATSAPP` setting | Also send the summary to your "Message yourself" chat |
| `wait` | `false` | `false`: answer `202 {"status":"started"}` right away (get the result from `/v1/summaries/latest`, the stream, or the webhook). `true`: wait and answer `201 {"status":"created","summary":{...}}` or `200 {"status":"empty","summary":null}` |

With a big backlog and `CHUNK_WAIT=60000`, a summary can take minutes, so
prefer `wait: false` plus the stream or webhook.

### Examples

```bash
KEY=your_api_key
curl -s http://127.0.0.1:3000/v1/status -H "Authorization: Bearer $KEY"
```

```bash
curl -s -X POST http://127.0.0.1:3000/v1/summaries \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"deliver": false, "wait": true}'
```

```bash
curl -s -X POST http://127.0.0.1:3000/v1/groups/watched \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name": "Project team"}'
```

```bash
curl -s -X PATCH http://127.0.0.1:3000/v1/settings \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"mode": "both"}'
```

A complete Node.js client (status, history, live stream) is in
[`examples/api-client.js`](../examples/api-client.js).

## Live stream (Server-Sent Events)

`GET /v1/stream` keeps the connection open and pushes events as they happen —
ideal for a dashboard that updates by itself.

```text
event: summary.created
data: {"id":"…","createdAt":"…","reason":"schedule","messageCount":42,"groups":["Team"],"delivered":true,"text":"…"}

event: alert.created
data: {"id":"…","createdAt":"…","group":"Team","text":"Meeting moved to 3 PM today","urgent":true}

event: settings.updated
data: {"mode":"both","deliverToWhatsApp":true}
```

Lines starting with `:` are keep-alive pings (every 25 s); ignore them.
Up to 20 streams can be open at once.

The browser's `EventSource` can't send headers, so read the stream from your
backend (see `stream()` in `examples/api-client.js`) and forward it to your
frontend through your own authenticated channel.

## Webhooks

Instead of (or as well as) polling, the bot can **push** every new summary and
alert to your project:

```env
WEBHOOK_URL=https://your-app.example.com/hooks/whatsapp-summary
WEBHOOK_SECRET=<64 hex chars>   # npm run secret
```

- `https://` is required (plain `http://` only for `localhost`).
- Events: `summary.created`, `alert.created`.
- Retries on network errors, `408`, `429` and `5xx`: 4 attempts, waiting 5 s,
  15 s, 45 s. Any `2xx` counts as delivered. Redirects are not followed.

Request:

```http
POST /hooks/whatsapp-summary
Content-Type: application/json
X-Summarizer-Event: summary.created
X-Summarizer-Delivery: 9b1c…          (same on retries; use it to skip duplicates)
X-Summarizer-Timestamp: 1793952000
X-Summarizer-Signature: sha256=5f2a…

{"id":"9b1c…","event":"summary.created","createdAt":"…","data":{ …summary… }}
```

**Always verify the signature** before trusting the body:

```js
const crypto = require('crypto');

function isGenuine(rawBody, timestamp, signature, secret) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // replay guard
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Use the **raw** request body (before JSON parsing). A ready receiver is in
[`examples/webhook-receiver.js`](../examples/webhook-receiver.js).

Python:

```python
import hmac, hashlib, time

def is_genuine(raw_body: bytes, timestamp: str, signature: str, secret: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

## Exposing the API safely

By default the API listens on `127.0.0.1` only, so nothing outside the server
can reach it. If your dashboard runs on another machine:

1. Keep `API_HOST=127.0.0.1`.
2. Put a reverse proxy with HTTPS in front. With [Caddy](https://caddyserver.com)
   (automatic certificates), `/etc/caddy/Caddyfile`:

   ```caddy
   summarizer.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   With nginx, also turn off buffering for the stream:

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_buffering off;          # needed for /v1/stream
       proxy_read_timeout 1h;
   }
   ```

3. Set `API_TRUST_PROXY=true` so rate limits see the real client IP.
   (Only behind a proxy: otherwise clients could fake their IP.)
4. Open only 80/443 in the firewall: `sudo ufw allow 80,443/tcp`.
   Do **not** open port 3000.
5. If a browser app on another domain calls the API through your proxy, add
   that exact origin to `API_CORS_ORIGINS`.

Alternatives without a public domain: an SSH tunnel
(`ssh -L 3000:127.0.0.1:3000 bot@server`), Tailscale/WireGuard, or Cloudflare
Tunnel.

## Errors and limits

Errors always look like:

```json
{ "error": { "code": "unauthorized", "message": "Missing or invalid API key" } }
```

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request`, `invalid_json` | Bad body or parameters |
| 401 | `unauthorized` | Missing / wrong key |
| 403 | `raw_messages_disabled` | `include=messages` without `API_ALLOW_RAW_MESSAGES=true` |
| 404 | `not_found`, `group_not_found` | Unknown route, id or group |
| 405 | `method_not_allowed` | Wrong HTTP method |
| 409 | `busy` | A summary is already running |
| 413 | `payload_too_large` | Body over 16 KB |
| 415 | `unsupported_media_type` | Body is not `application/json` |
| 429 | `rate_limited`, `too_many_auth_failures` | Too many requests (see `Retry-After`) |
| 502 | `summary_failed` | The AI provider failed (pending messages are kept) |
| 503 | `whatsapp_not_ready`, `too_many_streams` | WhatsApp still connecting / stream limit |

Default rate limit: 60 requests per minute per IP (`API_RATE_LIMIT`).

## Data shapes

**Summary**

```json
{
  "id": "0c6f…",
  "createdAt": "2026-11-05T19:00:04.211Z",
  "reason": "schedule | command | api | manual",
  "messageCount": 42,
  "groups": ["Team", "Course"],
  "delivered": true,
  "text": "⚠️ عاجل\n- …"
}
```

**Alert**

```json
{
  "id": "5a1d…",
  "createdAt": "2026-11-05T14:12:40.003Z",
  "group": "Team",
  "text": "Meeting moved to 3 PM today",
  "urgent": true
}
```

**Watched group**: `{ "id": "1203…@g.us", "name": "Team" }`
