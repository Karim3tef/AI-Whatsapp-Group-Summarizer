# Changelog

## 1.0.0 — 2026-11-05

First release.

- Watch any WhatsApp groups you choose and summarize them with any
  OpenAI-compatible AI (Groq, OpenRouter, Ollama…).
- Three modes: **schedule** (summary at fixed times), **realtime** (alert as
  soon as an important message appears), **both**. Switch live with `!وضع`
  or the API.
- Summaries and alerts arrive in your WhatsApp "Message yourself" chat.
- Pick groups from WhatsApp by number (`!جروبات`, `!تابع 3`); groups stay
  watched after renames.
- Quiet hours for real-time alerts (urgent ones can still come through).
- Keyword alerts without AI (`URGENT_KEYWORDS`).
- Optional REST API with API keys, rate limiting, live event stream (SSE),
  summary/alert history and group management.
- Optional signed webhooks (`summary.created`, `alert.created`).
- Optional AES-256-GCM encryption of all data files.
- Setup wizard (`npm run setup`) that generates every secret.
- pm2 and Docker deployment, Ubuntu setup script, tests and CI.
