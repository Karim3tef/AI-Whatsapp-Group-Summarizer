# Security

This bot is linked to your WhatsApp account and reads private group
conversations, so it is built to be safe by default. This page explains what
is protected, how, and what you still need to do yourself.

## What is sensitive

| Item | Where | Why it matters |
|---|---|---|
| WhatsApp session | `.wwebjs_auth/` | Anyone with this folder can use your WhatsApp account |
| Settings and secrets | `.env` | AI key, API keys, webhook secret, encryption key |
| Pending messages, summaries, alerts, groups | `data/*.json` | Private chat content |

## What the project does for you

**Secrets and files**
- `.env`, `.wwebjs_auth/`, `.wwebjs_cache/` and `data/` are in `.gitignore` and `.dockerignore`.
- `data/` files are written with mode `600` (folder `700`), atomically (temp file + rename).
- Optional encryption of all `data/*.json` files with **AES-256-GCM**
  (`DATA_ENCRYPTION_KEY`). Tampering is detected. A missing or wrong key stops
  the bot instead of overwriting the data. Plain files are encrypted on their
  next write when you turn this on.
- An unreadable file is moved aside (`*.corrupt-<time>`) instead of overwritten.
- No archive builds up: pending messages are deleted after each successful
  summary, and only the last `SUMMARY_HISTORY` summaries / `ALERT_HISTORY`
  alerts are kept (set to `0` to keep none).
- `npm run setup` writes `.env` with mode `600` and generates every secret
  with a cryptographically secure random generator.

**HTTP API** (off unless `API_ENABLED=true`)
- Listens on `127.0.0.1` by default; a warning is logged if bound elsewhere.
- Refuses to start with no API key or a key shorter than 32 characters.
- Constant-time key comparison; multiple keys for rotation.
- Per-IP rate limit and lock-out after 10 bad keys in 15 minutes.
- Raw message text is never returned unless `API_ALLOW_RAW_MESSAGES=true`.
- 16 KB body limit, strict JSON, request/header timeouts, max 20 live streams.
- Security headers on every response (`nosniff`, `no-store`, `DENY` framing,
  strict CSP, `no-referrer`); CORS only for origins you list.
- Internal errors are logged, but clients only get a generic message.

**Webhooks**
- `https://` required (except `localhost`).
- Every request is signed with HMAC-SHA256 over `timestamp.body`, so receivers
  can reject forged or replayed requests. Redirects are not followed.

**WhatsApp commands**
- Only accepted from your own "Message yourself" chat; anyone else typing
  `!ملخص` in a group is ignored.

**Docker**
- Runs as the unprivileged `node` user, `no-new-privileges`, all capabilities
  dropped, API port published on `127.0.0.1` only.

## What you should do

1. Use a server only you control (anyone with root can read everything).
2. Run the bot as its own user, not root.
3. SSH with keys, not passwords; enable the firewall (`ufw allow OpenSSH`, `ufw enable`).
4. Turn on `DATA_ENCRYPTION_KEY` and keep a copy of the key somewhere safe.
5. If you expose the API, put it behind HTTPS (see [docs/API.md](docs/API.md#exposing-the-api-safely)),
   and give each client its own key.
6. With OpenRouter, turn off training/logging for free models.
   For zero data leaving your server, use Ollama.
7. Check **Linked devices** on your phone from time to time. **Log out** the
   device to cut the bot off instantly.
8. If a secret leaks: replace it in `.env` and restart. For a leaked
   `.wwebjs_auth/`, log the device out from your phone right away.

Note: the WhatsApp session folder can't be encrypted by the bot (Chromium
needs to read it). Protect it with file permissions and, ideally, full-disk
encryption on the server.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/Karim3tef/AI-Whatsapp-Group-Summarizer/security/advisories/new)
with steps to reproduce. You'll get an answer as soon as possible.
