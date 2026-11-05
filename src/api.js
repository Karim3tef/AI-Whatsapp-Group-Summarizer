'use strict';

const http = require('http');
const { matchesAny } = require('./crypto');
const { MODES } = require('./modes');

const MAX_BODY = 16 * 1024;
const AUTH_FAIL_LIMIT = 10;
const AUTH_FAIL_WINDOW = 15 * 60 * 1000;
const MAX_STREAMS = 20;
const STREAM_EVENTS = ['summary.created', 'alert.created', 'settings.updated'];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Fixed-window counter per key (IP). Old entries are swept periodically. */
function createCounter(windowMs) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || now - entry.start >= windowMs) entry = { start: now, count: 0 };
      entry.count++;
      hits.set(key, entry);
      return { count: entry.count, resetMs: entry.start + windowMs - now };
    },
    get(key) {
      const entry = hits.get(key);
      if (!entry || Date.now() - entry.start >= windowMs) return 0;
      return entry.count;
    },
    sweep() {
      const now = Date.now();
      for (const [k, e] of hits) if (now - e.start >= windowMs) hits.delete(k);
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'payload_too_large', `Body must be under ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        return reject(new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json'));
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'invalid_json', 'Body must be a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * REST API so other projects can read summaries, trigger new ones and manage
 * watched groups. Every /v1 route needs an API key:
 *
 *   Authorization: Bearer <API key>      (or  X-API-Key: <API key>)
 *
 * See docs/API.md for every route.
 *
 * @param {object} deps
 * @param {object} deps.apiConfig        config.api
 * @param {import('./storage').MessageStore} deps.store
 * @param {import('./storage').GroupStore} deps.groups
 * @param {import('./storage').HistoryStore} deps.summaries
 * @param {import('./storage').HistoryStore} deps.alerts
 * @param {import('./storage').SettingsStore} deps.settings
 * @param {import('events').EventEmitter} deps.bus   emits summary.created / alert.created / settings.updated
 * @param {() => object} deps.getRuntime  live numbers (real-time queue, held alerts...)
 * @param {{ summarize: Function, isBusy: Function, getLastRun: Function }} deps.summarizer
 * @param {() => Promise<Array<{id: string, name: string}>>} deps.listGroupChats
 * @param {() => boolean} deps.isReady   true once WhatsApp is connected
 * @param {() => (Date|null)} deps.getNextRun
 * @param {object} deps.info             { model, schedule, timezone, quietHours, version }
 * @param {object} deps.logger
 */
function createApiServer(deps) {
  const { apiConfig, store, groups, summaries, alerts, settings, bus, getRuntime, summarizer, listGroupChats, isReady, getNextRun, info, logger } = deps;
  const startedAt = Date.now();
  const streams = new Set();
  const rate = createCounter(60 * 1000);
  const authFails = createCounter(AUTH_FAIL_WINDOW);
  const sweeper = setInterval(() => {
    rate.sweep();
    authFails.sweep();
  }, 60 * 1000);
  sweeper.unref();

  const requireReady = () => {
    if (!isReady()) throw new HttpError(503, 'whatsapp_not_ready', 'WhatsApp is not connected yet');
  };

  const routes = [
    ['GET', /^\/health$/, { public: true }, () => ({
      status: 'ok',
      whatsapp: isReady() ? 'ready' : 'connecting',
    })],

    ['GET', /^\/v1\/status$/, {}, () => {
      const last = summarizer.getLastRun();
      const next = getNextRun();
      return {
        whatsapp: isReady() ? 'ready' : 'connecting',
        version: info.version,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        pendingMessages: store.count,
        watchedGroups: groups.count,
        summarizing: summarizer.isBusy(),
        mode: settings.get('mode'),
        deliverToWhatsApp: settings.get('deliverToWhatsApp'),
        schedule: info.schedule,
        timezone: info.timezone,
        quietHours: info.quietHours,
        nextRun: next ? next.toISOString() : null,
        lastRun: last ? { ...last, at: last.at.toISOString() } : null,
        model: info.model,
        ...getRuntime(),
      };
    }],

    ['GET', /^\/v1\/settings$/, {}, () => ({ settings: settings.all() })],

    ['PATCH', /^\/v1\/settings$/, {}, ({ body }) => {
      const allowed = ['mode', 'deliverToWhatsApp'];
      const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
      if (unknown.length) throw new HttpError(400, 'invalid_request', `Unknown setting(s): ${unknown.join(', ')}`);
      if (body.mode !== undefined && !MODES.includes(body.mode)) {
        throw new HttpError(400, 'invalid_request', `"mode" must be one of ${MODES.join(', ')}`);
      }
      if (body.deliverToWhatsApp !== undefined && typeof body.deliverToWhatsApp !== 'boolean') {
        throw new HttpError(400, 'invalid_request', '"deliverToWhatsApp" must be true or false');
      }
      for (const k of allowed) if (body[k] !== undefined) settings.set(k, body[k]);
      const all = settings.all();
      bus.emit('settings.updated', all);
      return { settings: all };
    }],

    ['GET', /^\/v1\/alerts$/, {}, ({ query }) => {
      const limit = Math.min(Math.max(Number(query.get('limit')) || 20, 1), 100);
      return { alerts: alerts.list(limit) };
    }],

    ['GET', /^\/v1\/stream$/, { stream: true }, () => null],

    ['GET', /^\/v1\/groups$/, {}, async () => {
      requireReady();
      const chats = await listGroupChats();
      return { groups: chats.map((c) => ({ ...c, watched: groups.isWatched(c) })) };
    }],

    ['GET', /^\/v1\/groups\/watched$/, {}, () => ({ groups: groups.list() })],

    ['POST', /^\/v1\/groups\/watched$/, {}, async ({ body }) => {
      const { id, name } = body;
      if (typeof id !== 'string' && typeof name !== 'string') {
        throw new HttpError(400, 'invalid_request', 'Send {"id": "<group id>"} or {"name": "<exact group name>"}');
      }
      requireReady();
      const chats = await listGroupChats();
      const chat = typeof id === 'string' ? chats.find((c) => c.id === id) : chats.find((c) => c.name === name);
      if (!chat) throw new HttpError(404, 'group_not_found', 'No group with that id/name on this account');
      const added = groups.add(chat);
      return { status: added ? 201 : 200, body: { added, group: chat } };
    }],

    ['DELETE', /^\/v1\/groups\/watched\/(.+)$/, {}, ({ params }) => {
      const key = params[0];
      const entry = groups.list().find((g) => g.id === key || g.name === key);
      if (!entry) throw new HttpError(404, 'group_not_found', 'That group is not watched');
      groups.remove(entry);
      return { removed: true, group: entry };
    }],

    ['GET', /^\/v1\/messages\/pending$/, {}, ({ query }) => {
      const result = { count: store.count, byGroup: store.countByGroup() };
      if (query.get('include') === 'messages') {
        if (!apiConfig.allowRawMessages) {
          throw new HttpError(403, 'raw_messages_disabled', 'Set API_ALLOW_RAW_MESSAGES=true to expose raw messages');
        }
        result.messages = store.snapshot();
      }
      return result;
    }],

    ['DELETE', /^\/v1\/messages\/pending$/, {}, () => ({ cleared: store.clear() })],

    ['POST', /^\/v1\/summaries$/, {}, async ({ body }) => {
      if (body.deliver !== undefined && typeof body.deliver !== 'boolean') {
        throw new HttpError(400, 'invalid_request', '"deliver" must be true or false');
      }
      const deliver = body.deliver === undefined ? settings.get('deliverToWhatsApp') : body.deliver;
      if (deliver) requireReady();
      if (summarizer.isBusy()) throw new HttpError(409, 'busy', 'A summary is already running');

      const run = summarizer.summarize({ reason: 'api', deliver, quietIfEmpty: true });
      if (body.wait !== true) {
        run.catch(() => {});
        return { status: 202, body: { status: 'started', pendingMessages: store.count } };
      }
      const result = await run;
      if (result.status === 'failed') throw new HttpError(502, 'summary_failed', result.error);
      if (result.status === 'empty') return { status: 'empty', summary: null };
      if (result.status === 'busy') throw new HttpError(409, 'busy', 'A summary is already running');
      return { status: 201, body: { status: 'created', summary: result.summary } };
    }],

    ['GET', /^\/v1\/summaries$/, {}, ({ query }) => {
      const limit = Math.min(Math.max(Number(query.get('limit')) || 10, 1), 100);
      return { summaries: summaries.list(limit) };
    }],

    ['GET', /^\/v1\/summaries\/latest$/, {}, () => {
      const s = summaries.latest();
      if (!s) throw new HttpError(404, 'not_found', 'No summaries yet');
      return { summary: s };
    }],

    ['GET', /^\/v1\/summaries\/([\w-]+)$/, {}, ({ params }) => {
      const s = summaries.get(params[0]);
      if (!s) throw new HttpError(404, 'not_found', 'Summary not found');
      return { summary: s };
    }],
  ];

  function clientIp(req) {
    if (apiConfig.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function apiKeyFrom(req) {
    const auth = String(req.headers.authorization || '');
    if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    return String(req.headers['x-api-key'] || '').trim();
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin || !apiConfig.corsOrigins.includes(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, X-API-Key, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }

  async function handle(req, res) {
    const ip = clientIp(req);
    const headers = { ...SECURITY_HEADERS, ...corsHeaders(req) };
    const reply = (status, body, extra = {}) => {
      res.writeHead(status, { ...headers, ...extra });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const fail = (err, extra) => reply(err.status, { error: { code: err.code, message: err.message } }, extra);

    try {
      if (req.method === 'OPTIONS') return reply(204);

      const { count, resetMs } = rate.hit(ip);
      if (count > apiConfig.rateLimit) {
        return fail(new HttpError(429, 'rate_limited', 'Too many requests'), {
          'Retry-After': String(Math.ceil(resetMs / 1000)),
        });
      }

      const url = new URL(req.url, 'http://localhost');
      const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
      if (!route) {
        const pathExists = routes.some(([, pattern]) => pattern.test(url.pathname));
        throw pathExists
          ? new HttpError(405, 'method_not_allowed', 'Method not allowed')
          : new HttpError(404, 'not_found', 'Route not found');
      }
      const [, pattern, options, handler] = route;

      if (!options.public) {
        if (authFails.get(ip) >= AUTH_FAIL_LIMIT) {
          throw new HttpError(429, 'too_many_auth_failures', 'Too many invalid API keys. Try again later.');
        }
        if (!matchesAny(apiKeyFrom(req), apiConfig.keys)) {
          authFails.hit(ip);
          logger.warn(`API: rejected invalid key from ${ip}`);
          return fail(new HttpError(401, 'unauthorized', 'Missing or invalid API key'), {
            'WWW-Authenticate': 'Bearer',
          });
        }
      }

      let params;
      try {
        params = pattern.exec(url.pathname).slice(1).map(decodeURIComponent);
      } catch {
        throw new HttpError(400, 'invalid_request', 'Malformed URL');
      }
      if (options.stream) return openStream(req, res, headers);

      const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : {};
      const result = await handler({ body, params, query: url.searchParams });

      if (result && typeof result.status === 'number' && result.body !== undefined) {
        return reply(result.status, result.body);
      }
      return reply(200, result);
    } catch (err) {
      if (err instanceof HttpError) return fail(err);
      logger.error(`API error on ${req.method} ${req.url}:`, err.message);
      return fail(new HttpError(500, 'internal_error', 'Something went wrong'));
    }
  }

  /**
   * Server-Sent Events: one long response that receives every new summary,
   * alert and settings change as it happens. Comment lines keep proxies from
   * closing the connection.
   */
  function openStream(req, res, headers) {
    if (streams.size >= MAX_STREAMS) {
      res.writeHead(503, headers);
      res.end(JSON.stringify({ error: { code: 'too_many_streams', message: 'Too many open streams' } }));
      return;
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const listeners = STREAM_EVENTS.map((event) => {
      const fn = (data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      bus.on(event, fn);
      return [event, fn];
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    const entry = { res, close: null };
    entry.close = () => {
      clearInterval(ping);
      for (const [event, fn] of listeners) bus.off(event, fn);
      streams.delete(entry);
    };
    streams.add(entry);
    req.on('close', entry.close);
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(apiConfig.port, apiConfig.host, () => {
          server.off('error', reject);
          const addr = server.address();
          logger.info(`API listening on http://${apiConfig.host}:${addr.port}`);
          if (!['127.0.0.1', 'localhost', '::1'].includes(apiConfig.host)) {
            logger.warn('API is reachable from the network. Put it behind HTTPS (see docs/API.md).');
          }
          resolve(addr.port);
        });
      });
    },
    close() {
      clearInterval(sweeper);
      for (const entry of [...streams]) {
        entry.close();
        entry.res.end();
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createApiServer, HttpError };
