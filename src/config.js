'use strict';

const path = require('path');
const cron = require('node-cron');
const { loadPrompt, DEFAULT_REALTIME_PROMPT } = require('./prompt');
const { MODES, parseQuietHours } = require('./modes');
const { parseKey } = require('./crypto');

const ROOT = path.resolve(__dirname, '..');
const MIN_SECRET_LENGTH = 32;

/** Splits a list like "a | b | c" into clean items. */
function parseList(value, separator) {
  if (!value) return [];
  return value
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isLocalHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

/**
 * Builds the app configuration from environment variables and validates it.
 * Throws one Error listing every problem so .env can be fixed in one go.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function loadConfig(env = process.env) {
  const problems = [];
  const str = (name, fallback = '') => (env[name] === undefined ? fallback : String(env[name]).trim());
  const required = (name) => {
    const v = str(name);
    if (!v) problems.push(`${name} is missing`);
    return v;
  };
  const num = (name, fallback, min = 0) => {
    const raw = str(name);
    if (raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) {
      problems.push(`${name} must be a number >= ${min} (got "${raw}")`);
      return fallback;
    }
    return n;
  };
  const bool = (name, fallback) => {
    const raw = str(name).toLowerCase();
    if (raw === '') return fallback;
    if (['true', '1', 'yes', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'off'].includes(raw)) return false;
    problems.push(`${name} must be true or false (got "${raw}")`);
    return fallback;
  };
  const url = (name, value) => {
    try {
      return new URL(value);
    } catch {
      problems.push(`${name} "${value}" is not a valid URL`);
      return null;
    }
  };

  // --- AI provider ---
  const ai = {
    url: required('AI_URL'),
    key: required('AI_KEY'),
    model: required('AI_MODEL'),
    maxRetries: num('AI_MAX_RETRIES', 3),
    timeoutMs: num('AI_TIMEOUT', 120000, 1000),
  };
  if (ai.url) url('AI_URL', ai.url);

  // --- Schedule ---
  const schedule = str('SCHEDULE', '0 21 * * *');
  if (!cron.validate(schedule)) problems.push(`SCHEDULE "${schedule}" is not a valid cron expression`);
  const timezone = str('TIMEZONE', 'Africa/Cairo');
  if (!isValidTimezone(timezone)) problems.push(`TIMEZONE "${timezone}" is not a valid IANA time zone`);

  // --- Mode ---
  const mode = str('MODE', 'schedule').toLowerCase();
  if (!MODES.includes(mode)) problems.push(`MODE must be one of ${MODES.join(', ')} (got "${mode}")`);

  let quietHours = null;
  if (str('QUIET_HOURS')) {
    quietHours = parseQuietHours(str('QUIET_HOURS'));
    if (!quietHours) problems.push(`QUIET_HOURS must look like 23:00-07:00 (got "${str('QUIET_HOURS')}")`);
  }

  // --- Prompts ---
  const promptFrom = (name, fallback) => {
    try {
      return loadPrompt(str(name) ? path.resolve(ROOT, str(name)) : undefined, fallback);
    } catch (err) {
      problems.push(`${name}: ${err.message}`);
      return fallback;
    }
  };
  const prompt = promptFrom('PROMPT_FILE', undefined);
  const realtimePrompt = promptFrom('REALTIME_PROMPT_FILE', DEFAULT_REALTIME_PROMPT);

  // --- Data at rest ---
  let encryptionKey;
  if (str('DATA_ENCRYPTION_KEY')) {
    try {
      encryptionKey = parseKey(str('DATA_ENCRYPTION_KEY'));
    } catch (err) {
      problems.push(`DATA_ENCRYPTION_KEY ${err.message}`);
    }
  }

  // --- HTTP API ---
  const apiKeys = parseList(str('API_KEYS'), ',');
  const api = {
    enabled: bool('API_ENABLED', false),
    host: str('API_HOST', '127.0.0.1'),
    port: num('API_PORT', 3000, 1),
    keys: apiKeys,
    trustProxy: bool('API_TRUST_PROXY', false),
    corsOrigins: parseList(str('API_CORS_ORIGINS'), ','),
    rateLimit: num('API_RATE_LIMIT', 60, 1),
    allowRawMessages: bool('API_ALLOW_RAW_MESSAGES', false),
  };
  if (api.port > 65535) problems.push('API_PORT must be <= 65535');
  if (api.enabled) {
    if (!apiKeys.length) problems.push('API_ENABLED=true needs API_KEYS (run: npm run secret)');
    for (const k of apiKeys) {
      if (k.length < MIN_SECRET_LENGTH) {
        problems.push(`every API key must be at least ${MIN_SECRET_LENGTH} characters (run: npm run secret)`);
        break;
      }
    }
  }

  // --- Webhook ---
  const webhook = { url: str('WEBHOOK_URL'), secret: str('WEBHOOK_SECRET') };
  if (webhook.url) {
    const u = url('WEBHOOK_URL', webhook.url);
    if (u && u.protocol !== 'https:' && !isLocalHost(u.hostname)) {
      problems.push('WEBHOOK_URL must use https:// (plain http is only allowed for localhost)');
    }
    if (webhook.secret.length < MIN_SECRET_LENGTH) {
      problems.push(`WEBHOOK_URL needs WEBHOOK_SECRET of at least ${MIN_SECRET_LENGTH} characters (run: npm run secret)`);
    }
  }

  const config = {
    ai,
    chunkSize: num('CHUNK_SIZE', 8000, 500),
    chunkWait: num('CHUNK_WAIT', 60000),
    maxStored: num('MAX_STORED_MESSAGES', 5000, 1),
    summaryHistory: num('SUMMARY_HISTORY', 30),
    deliverToWhatsApp: bool('DELIVER_TO_WHATSAPP', true),
    mode,
    realtime: {
      debounceMs: num('REALTIME_DEBOUNCE', 120000, 0),
      maxWaitMs: num('REALTIME_MAX_WAIT', 600000, 0),
      prompt: realtimePrompt,
    },
    alertHistory: num('ALERT_HISTORY', 100),
    quietHours,
    quietHoursAllowUrgent: bool('QUIET_HOURS_ALLOW_URGENT', true),
    schedule,
    timezone,
    prompt,
    // Seed list used only the first time, before data/groups.json exists.
    initialGroups: parseList(str('GROUPS'), '|'),
    urgentKeywords: parseList(str('URGENT_KEYWORDS'), ','),
    encryptionKey,
    api,
    webhook: webhook.url ? webhook : null,
    authDir: path.resolve(ROOT, str('AUTH_DIR') || '.wwebjs_auth'),
    chromiumPath: str('PUPPETEER_EXECUTABLE_PATH') || undefined,
  };

  if (problems.length) {
    const err = new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    throw err;
  }

  const dataDir = path.resolve(ROOT, str('DATA_DIR') || 'data');
  return {
    ...config,
    dataDir,
    messagesFile: path.join(dataDir, 'messages.json'),
    groupsFile: path.join(dataDir, 'groups.json'),
    summariesFile: path.join(dataDir, 'summaries.json'),
    alertsFile: path.join(dataDir, 'alerts.json'),
    settingsFile: path.join(dataDir, 'settings.json'),
  };
}

module.exports = { loadConfig, parseList, MIN_SECRET_LENGTH };
