# Architecture

How the code is organized and how a message flows through it. For setup and
usage see the [README](../README.md); for the HTTP API see [API.md](API.md).

## Overview

```
                         ┌─────────────────────────── src/bot.js ───────────────────────────┐
 WhatsApp (phone)        │                                                                   │
   │  linked device      │  'message' ──► GroupStore.matches? ──► MessageStore.add (queue)    │
   ▼                     │                        │                                          │
 whatsapp-web.js ───────►│                        ├──► RealtimeWatcher.push  (mode realtime/both)
 (headless Chromium)     │                        └──► keyword alert         (URGENT_KEYWORDS)│
                         │                                                                   │
                         │  node-cron ──► Summarizer.summarize  (mode schedule/both)          │
                         │  'message_create' (Message yourself) ──► commands.js               │
                         │                                                                   │
                         │  Summarizer ──► ai.js ──► AI provider (Groq / OpenRouter / Ollama) │
                         │  RealtimeWatcher ──► ai.js ──► parseAlerts                         │
                         │       │                                                           │
                         │       ▼                                                           │
                         │  HistoryStore (summaries / alerts) ──► bus (EventEmitter)          │
                         │                                         ├──► webhook.js  (push)    │
                         │                                         └──► api.js /v1/stream     │
                         │  Notifier (quiet hours) ──► "Message yourself" chat                │
                         └───────────────────────────────────────────────────────────────────┘
```

## Modules

| File | Responsibility |
|---|---|
| `src/index.js` | Entry point: loads `.env`, validates config, starts the bot, handles SIGINT/SIGTERM |
| `src/config.js` | Reads every setting, applies defaults, reports **all** problems at once |
| `src/bot.js` | Creates the WhatsApp client and wires every other module together |
| `src/storage.js` | `JsonFile` (atomic, private, optional AES-256-GCM), `MessageStore`, `GroupStore`, `HistoryStore`, `SettingsStore` |
| `src/crypto.js` | Encryption, constant-time secret check, HMAC signing, random secrets |
| `src/ai.js` | OpenAI-compatible chat client with timeout, retry and `Retry-After` support |
| `src/chunker.js` | Splits text on line boundaries to fit provider limits |
| `src/summarizer.js` | Queue → chunks → partial summaries → merge → deliver → history → clear |
| `src/realtime.js` | Debounced batches of new messages → AI decides what is important (JSON) → alerts |
| `src/notifier.js` | Sends to the user, holding non-urgent alerts during quiet hours |
| `src/modes.js` | Mode names (`schedule` / `realtime` / `both`) and quiet-hours math |
| `src/commands.js` | Parses and runs the `!` commands (Arabic + English) |
| `src/api.js` | Dependency-free HTTP server: auth, rate limiting, routes, SSE stream |
| `src/webhook.js` | Signed webhook delivery with retries, and a signature checker |
| `src/prompt.js` | Default instructions for summaries and real-time alerts |
| `scripts/setup.js` | Interactive wizard that writes `.env` and generates secrets |

Every module receives its dependencies as arguments (stores, `send`, `ai`,
`logger`, `sleep`, `fetchImpl`…), so tests run without WhatsApp, a browser or
network access.

## Message flow

1. **Receive.** whatsapp-web.js emits `message` for every incoming message.
   Messages you send yourself fire `message_create` instead and are only
   used for commands.
2. **Filter.** `GroupStore.matches()` checks the chat ID (or the name, for
   groups added by name in `GROUPS`). It records the ID on first match and
   follows renames.
3. **Queue.** The message is appended to `data/messages.json`. The queue is
   capped at `MAX_STORED_MESSAGES`.
4. **Real time (optional).** In `realtime`/`both` mode the message also goes
   to `RealtimeWatcher`, which waits `REALTIME_DEBOUNCE` after the last
   message (never more than `REALTIME_MAX_WAIT` after the first) and asks the
   AI about the whole batch in one request. The answer must be JSON
   `{"alerts":[…]}`; anything else is logged and ignored so the user is never
   spammed with garbage.
5. **Summary.** At `SCHEDULE` (in `schedule`/`both` mode), on `!ملخص`, or on
   `POST /v1/summaries`, the summarizer snapshots the queue, summarizes it in
   chunks (waiting `CHUNK_WAIT` between calls), merges the parts, delivers
   it, saves it to history, and removes **only** the messages it summarized.
   If anything fails, nothing is removed.
6. **Publish.** New summaries and alerts are emitted on an internal
   `EventEmitter`. The webhook and the API's live stream subscribe to it, so
   adding another output only means adding another listener.

## Runtime settings

`.env` holds the defaults. `mode` and `deliverToWhatsApp` can be changed while
running (`!وضع`, `PATCH /v1/settings`); overrides are saved in
`data/settings.json` and win over `.env` after a restart. Delete that file to
go back to the `.env` values.

## Data files

| File | Content | Cleared |
|---|---|---|
| `data/messages.json` | Pending messages | After each successful summary, or `!مسح` |
| `data/groups.json` | Watched groups `{id, name}` | Never (edit with commands / API) |
| `data/summaries.json` | Last `SUMMARY_HISTORY` summaries | Rolling |
| `data/alerts.json` | Last `ALERT_HISTORY` alerts | Rolling |
| `data/settings.json` | Runtime overrides | Never |

All are written atomically with mode `600`, and encrypted when
`DATA_ENCRYPTION_KEY` is set (`{"encrypted":true,"alg":"aes-256-gcm","iv","tag","data"}`).

## Reliability

- `disconnected` exits the process; pm2 (`ecosystem.config.js`) or Docker
  (`restart: unless-stopped`) starts it again with a fresh browser.
- AI calls retry on `408/409/425/429/5xx` and network errors with backoff,
  honoring `Retry-After`.
- Only one summary runs at a time; a second request gets "busy".
- The cron job is created once even if WhatsApp reconnects and fires `ready`
  again.

## Tests

`npm test` runs `node:test` suites in `test/` for every module, including an
HTTP test of the API on a random port. CI (`.github/workflows/ci.yml`) runs
them on Node 20, 22 and 24 and builds the Docker image.
