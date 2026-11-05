# AI WhatsApp Group Summarizer

[![CI](https://github.com/Karim3tef/AI-Whatsapp-Group-Summarizer/actions/workflows/ci.yml/badge.svg)](https://github.com/Karim3tef/AI-Whatsapp-Group-Summarizer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

A WhatsApp bot that runs on your VPS or your own computer. It watches **the
groups you choose** (study, work, courses, family, communities…), uses a free
AI model to pull out only what matters (dates, deadlines, changes, decisions,
announcements), and sends it to your WhatsApp **"Message yourself"** chat:

- 🕘 a **scheduled summary** at the times you pick, or
- ⚡ a **real-time alert** as soon as an important message appears, or **both**.

To plug it into a dashboard or another project, there is an optional
**API-key-protected REST API**, a **live event stream**, and **signed webhooks**.

> 🇪🇬 النسخة العربية: [README.md](README.md)

---

## Contents
- [Features](#features)
- [Modes](#modes)
- [How it works](#how-it-works)
- [WhatsApp commands](#whatsapp-commands)
- [Choosing an AI provider](#choosing-an-ai-provider)
- [Privacy](#privacy)
- [Install on a VPS](#install-on-a-vps)
- [Run on your computer](#run-on-your-computer)
- [Run with Docker](#run-with-docker)
- [Connect a dashboard or another project](#connect-a-dashboard-or-another-project)
- [Configuration](#configuration)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

> ⚠️ This project uses an unofficial library ([whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)),
> which is against WhatsApp's Terms of Service. There is a small risk of the
> number being banned. The bot only reads and sends a few messages to
> yourself, which lowers the risk but doesn't remove it. Use at your own risk.

---

## Features

**Core**
- Watches only the groups you pick; ignores everything else.
- Pick groups from WhatsApp by number (`!groups`, `!watch 3`), via the API, or in `.env`.
- Groups stay watched after they are renamed (matched by ID).
- Everything arrives in "Message yourself" (can be turned off for API-only use).

**Summaries and alerts**
- **Schedule mode:** summary at fixed times (cron), any time zone.
- **Real-time mode:** the AI decides what's important and alerts you right away.
- **Both**, switchable any time with `!mode` — no restart.
- **Quiet hours:** alerts wait until morning and arrive together (urgent ones can pass).
- Keyword alerts without AI (`URGENT_KEYWORDS`).
- Splits big backlogs into chunks for free-tier limits, then merges the summaries.
- Automatic retries on `429` and provider errors.

**Integration and security**
- REST API with keys: summaries, alerts, groups, settings, trigger a summary.
- Live stream (Server-Sent Events) so dashboards update by themselves.
- HMAC-signed webhooks for every new summary/alert.
- AES-256-GCM encryption of data files; private file permissions.
- API binds to `127.0.0.1` by default; rate limiting; lock-out after bad keys; raw messages hidden by default.
- Setup wizard (`npm run setup`) that writes `.env` and generates every secret.
- pm2 and Docker deployment; 84 tests and CI.

## Modes

| Mode | What it does | Good for |
|---|---|---|
| `schedule` | One summary at the scheduled time | Reading once a day, no interruptions |
| `realtime` | Alert as soon as something important arrives | Plans that change fast |
| `both` | Real-time alerts + the daily summary | Maximum coverage |

**Saving free quota in real-time mode:** the bot doesn't call the AI for every
message. It waits until the group has been quiet for `REALTIME_DEBOUNCE`
(default 2 minutes, never more than `REALTIME_MAX_WAIT` = 10 minutes after the
first new message) and checks the whole batch in one request. The AI answers
with the important items only; if there's nothing, you get nothing.

Switch from WhatsApp any time: `!mode realtime`, `!mode schedule`, `!mode both`
(or Arabic `!وضع فوري` / `مجدول` / `الاتنين`). Messages are always queued, so
`!summary` works in every mode.

## How it works

1. **Link:** WhatsApp Web runs in headless Chromium, linked with a QR code
   like any linked device. The session is saved in `.wwebjs_auth`.
2. **Filter:** each new message is checked against the watched groups.
3. **Store:** saved to `data/messages.json` atomically, with mode `600`, and
   encrypted if you enable it. Nothing is lost on restart.
4. **Timing:** `node-cron` triggers scheduled summaries; real-time mode
   checks small batches.
5. **AI:** large summaries are chunked then merged; real-time checks return
   JSON with only the important items.
6. **Deliver:** to "Message yourself", respecting quiet hours.
7. **Clean up:** only after success are the summarized messages removed. On
   error everything stays for next time.
8. **Publish (optional):** saved to history and pushed to the API stream and webhook.

Technical details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## WhatsApp commands

Send them in your **"Message yourself"** chat only; anyone else typing them in
a group is ignored. Arabic and English names both work.

| Command | Arabic | What it does |
|---|---|---|
| `!summary` | `!ملخص` | Summarize the queued messages now |
| `!groups` | `!جروبات` | All your groups, numbered; ✅ marks watched ones |
| `!watch <number or name>` | `!تابع` | Start watching a group (`!watch 3`, `!watch team`) |
| `!unwatch <number or name>` | `!الغي` | Stop watching a group |
| `!watching` | `!متابعة` | Watched groups only |
| `!mode [schedule\|realtime\|both]` | `!وضع` | Show or change the mode |
| `!alerts` | `!تنبيهات` | Latest real-time alerts |
| `!status` | `!حالة` | Mode, queue, next run, last run, model |
| `!clear` | `!مسح` | Drop queued messages without summarizing |
| `!help` | `!مساعدة` | List commands |

## Choosing an AI provider

Any OpenAI-compatible API works; switch in `.env`.

| | **Groq** ⭐ | **OpenRouter (`:free`)** | **Ollama (local)** |
|---|---|---|---|
| Price | Free | Free | Free |
| Training on data | States it doesn't | Depends on host — **turn training off in Privacy settings** | None, all local |
| Limits | Small tokens/minute | ~50 requests/day, 20/minute | Your hardware |
| Stability | Stable | Free models come and go | Stable |
| RAM | — | — | 8 GB+ |

With Groq/OpenRouter, messages **are sent to their servers** to be processed.
Only Ollama keeps everything on your machine. Real-time mode uses more
requests than schedule mode; on OpenRouter's daily limit raise
`REALTIME_DEBOUNCE` or use Groq. Limits and policies change — check the
providers' pages.

## Privacy

| Who | Can see |
|---|---|
| The bot (code on your machine) | Linked to WhatsApp, so in theory everything; it only does what the open-source code does |
| AI provider | Text of watched-group messages, at summary/check time. Can't open your chats or send messages |
| Projects using your API | Summaries, alerts, settings. Raw messages **only** if `API_ALLOW_RAW_MESSAGES=true` |
| Anyone with root on the server | **Everything**, including the session. Use a server only you control |

## Install on a VPS

Ubuntu 22.04/24.04, 1 GB RAM minimum (2 GB better).

```bash
adduser bot && usermod -aG sudo bot && su - bot
```
```bash
sudo apt install -y git
git clone https://github.com/Karim3tef/AI-Whatsapp-Group-Summarizer.git
cd AI-Whatsapp-Group-Summarizer
bash scripts/setup-server.sh
```

The script installs Node.js LTS, Chromium libraries, pm2 and dependencies,
then runs the **setup wizard**, which asks for:
- AI provider, key and model;
- mode, summary time(s), time zone, quiet hours;
- whether to deliver to "Message yourself";
- data encryption (**generates the key**);
- API (**generates an API key**) and webhook (**generates the secret**).

It writes `.env` with mode `600` and prints the connection details for your
other project. Prefer editing by hand? `cp .env.example .env` — every option
is documented there; generate secrets with `npm run secret`.

**First run:**
```bash
npm start
```
1. Scan the QR code: WhatsApp → **Linked devices** → **Link a device**.
2. Wait for `✅ WhatsApp connected`.
3. In "Message yourself": `!groups`, then `!watch 3`, `!watch 7`…
4. Check with `!watching`, try `!status` and `!summary`, then `Ctrl+C`.

**Keep it running:**
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # run the sudo line it prints
```

## Run on your computer

Works on Windows, macOS and Linux (the computer must stay on):

```bash
git clone https://github.com/Karim3tef/AI-Whatsapp-Group-Summarizer.git
cd AI-Whatsapp-Group-Summarizer
npm install
npm run setup
npm start
```

`npm install` downloads Chromium automatically.

## Run with Docker

```bash
npm run setup                 # or: cp .env.example .env && nano .env
docker compose up -d --build
docker compose logs -f        # scan the QR, then Ctrl+C
```

The session and data live in Docker volumes. The container runs as a
non-root user with no extra privileges, and the API (if enabled) is published
on `127.0.0.1:3000` only.

## Connect a dashboard or another project

**Optional** — "Message yourself" keeps working either way.

```env
API_ENABLED=true
API_HOST=127.0.0.1
API_PORT=3000
API_KEYS=<generated key>
```

```bash
curl http://127.0.0.1:3000/v1/summaries/latest -H "Authorization: Bearer $API_KEY"
```

| You want | Request |
|---|---|
| Latest summary | `GET /v1/summaries/latest` |
| Summary history | `GET /v1/summaries?limit=10` |
| Real-time alerts | `GET /v1/alerts` |
| Live dashboard updates | `GET /v1/stream` (SSE) |
| Summarize now | `POST /v1/summaries` (`{"deliver": false}` to skip WhatsApp) |
| Groups / watch / unwatch | `GET /v1/groups`, `POST /v1/groups/watched`, `DELETE /v1/groups/watched/{id}` |
| Change mode | `PATCH /v1/settings` with `{"mode": "realtime"}` |
| Status | `GET /v1/status` |

**Webhooks** — let the bot push to you:

```env
WEBHOOK_URL=https://your-app.com/hooks/whatsapp-summary
WEBHOOK_SECRET=<generated secret>
```

Each request is HMAC-SHA256 signed; verify it before trusting the body.

📘 Full reference (every route, errors, signature checks in Node and Python,
exposing the API safely over HTTPS): **[docs/API.md](docs/API.md)**

🧩 Ready-made examples: [examples/api-client.js](examples/api-client.js) and
[examples/webhook-receiver.js](examples/webhook-receiver.js).

> Never put the API key in browser code. Let your dashboard's backend call the API.

## Configuration

Every variable is documented in [`.env.example`](.env.example). The main ones:

| Variable | Default | Meaning |
|---|---|---|
| `AI_URL`, `AI_KEY`, `AI_MODEL` | required | AI provider |
| `CHUNK_SIZE` / `CHUNK_WAIT` | `8000` / `60000` | Chunk size (chars) / wait between chunks (ms) |
| `MODE` | `schedule` | `schedule`, `realtime` or `both` |
| `SCHEDULE` / `TIMEZONE` | `0 21 * * *` / `Africa/Cairo` | Cron and IANA time zone |
| `REALTIME_DEBOUNCE` / `REALTIME_MAX_WAIT` | `120000` / `600000` | Real-time batching (ms) |
| `QUIET_HOURS` | empty | e.g. `23:00-07:00` |
| `QUIET_HOURS_ALLOW_URGENT` | `true` | Urgent alerts pass during quiet hours |
| `DELIVER_TO_WHATSAPP` | `true` | Send to "Message yourself" |
| `URGENT_KEYWORDS` | empty | Instant keyword alerts, comma-separated |
| `GROUPS` | empty | Initial group names, `\|`-separated (first run only) |
| `DATA_ENCRYPTION_KEY` | empty | Encrypt `data/` (64 hex). **Back it up** |
| `SUMMARY_HISTORY` / `ALERT_HISTORY` | `30` / `100` | History kept for the API |
| `API_ENABLED`, `API_HOST`, `API_PORT`, `API_KEYS` | off, `127.0.0.1`, `3000` | HTTP API |
| `API_RATE_LIMIT`, `API_TRUST_PROXY`, `API_CORS_ORIGINS`, `API_ALLOW_RAW_MESSAGES` | `60`, `false`, empty, `false` | API hardening |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | empty | Signed webhooks |
| `PROMPT_FILE`, `REALTIME_PROMPT_FILE` | empty | Custom AI instructions |

If something is wrong, the bot refuses to start and lists **every** problem at once.

## Security

- `.wwebjs_auth/` is the key to your account: keep it private, never commit it.
- `.env` and `data/` files are mode `600`; turn on `DATA_ENCRYPTION_KEY`.
- API off by default, localhost-only when on. Expose it only through HTTPS
  ([how](docs/API.md#exposing-the-api-safely)).
- SSH keys, firewall (`ufw allow OpenSSH && ufw enable`), check Linked devices
  regularly, log the device out to cut access instantly.

Details and vulnerability reporting: [SECURITY.md](SECURITY.md).

## Troubleshooting

| Problem | Fix |
|---|---|
| `Invalid configuration` | The message says exactly what's wrong in `.env` |
| `error while loading shared libraries` | Run `bash scripts/setup-server.sh` |
| Commands don't answer | Send them in **"Message yourself"**, starting with `!` |
| A group isn't recorded | `!groups` → is it ✅? If not, `!watch <number>` |
| Your own messages aren't recorded | By design: only other people's messages are summarized |
| No real-time alerts | Check `!mode`; wait for `REALTIME_DEBOUNCE`; the AI may have found nothing important. See logs (`Real-time check`) |
| Too many alerts | Raise `REALTIME_DEBOUNCE` or write stricter rules in `REALTIME_PROMPT_FILE` |
| AI `401` / `429` | Wrong `AI_KEY` / rate limit (retries are automatic; lower `CHUNK_SIZE`, raise waits) |
| API `401` | Key not in `API_KEYS`, or wrong header |
| `could not be decrypted` | `DATA_ENCRYPTION_KEY` changed — restore the old one |
| Bot stopped after working | WhatsApp Web updated: `npm update whatsapp-web.js`, then `pm2 restart ai-whatsapp-group-summarizer` |
| Asks for QR again | `pm2 stop …` → `rm -rf .wwebjs_auth` → `npm start`, scan → `Ctrl+C` → `pm2 restart …` |

## Development

```bash
npm install
npm test
```

Tests need no WhatsApp or AI key. They cover chunking, storage, encryption,
summaries, real-time alerts, quiet hours, retries, commands, configuration,
the API (on a real HTTP server) and webhooks. CI runs them on Node 20, 22 and
24 and builds the Docker image.

Project layout and module responsibilities: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE) © Karim Atef Alanany
