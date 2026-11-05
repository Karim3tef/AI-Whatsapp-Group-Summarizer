'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encrypt, decrypt, isEnvelope } = require('./crypto');

/**
 * A JSON file on disk, optionally encrypted with AES-256-GCM.
 *
 * - Writes are atomic (temp file + rename) and private (mode 600).
 * - A broken file is moved aside (`*.corrupt-<time>`) instead of overwritten.
 * - An encrypted file with a missing or wrong key stops the bot instead of
 *   being replaced, so data is never silently lost.
 * - A plain file is read fine when a key is set; it is encrypted on next write.
 */
class JsonFile {
  /**
   * @param {string} file
   * @param {{ encryptionKey?: Buffer, logger?: object }} [options]
   */
  constructor(file, { encryptionKey, logger } = {}) {
    this.file = file;
    this.key = encryptionKey;
    this.logger = logger;
  }

  read(fallback) {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, aside);
      if (this.logger) this.logger.warn(`${this.file} was unreadable (${err.message}); moved to ${aside}.`);
      return fallback;
    }

    if (!isEnvelope(parsed)) return parsed;
    if (!this.key) {
      throw new Error(`${this.file} is encrypted but DATA_ENCRYPTION_KEY is not set`);
    }
    try {
      return JSON.parse(decrypt(parsed, this.key));
    } catch {
      throw new Error(`${this.file} could not be decrypted: wrong DATA_ENCRYPTION_KEY?`);
    }
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const json = JSON.stringify(value, null, 2);
    const out = this.key ? JSON.stringify(encrypt(json, this.key)) : json;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/**
 * Queue of group messages waiting to be summarized, persisted to disk so
 * nothing is lost if the bot restarts.
 */
class MessageStore {
  /**
   * @param {string} file
   * @param {{ maxStored?: number, encryptionKey?: Buffer, logger?: object }} [options]
   */
  constructor(file, { maxStored = 5000, encryptionKey, logger } = {}) {
    this.json = new JsonFile(file, { encryptionKey, logger });
    this.maxStored = maxStored;
    this.logger = logger;
    const loaded = this.json.read([]);
    this.messages = Array.isArray(loaded) ? loaded : [];
  }

  get count() {
    return this.messages.length;
  }

  /** Adds a message. Drops the oldest ones if the queue grows past maxStored. */
  add(message) {
    this.messages.push(message);
    const overflow = this.messages.length - this.maxStored;
    if (overflow > 0) {
      this.messages.splice(0, overflow);
      if (this.logger) this.logger.warn(`Message queue full, dropped ${overflow} oldest message(s).`);
    }
    this.save();
  }

  /** Copy of the current queue. */
  snapshot() {
    return this.messages.slice();
  }

  /** Number of pending messages per group name. */
  countByGroup() {
    const counts = {};
    for (const m of this.messages) counts[m.group] = (counts[m.group] || 0) + 1;
    return counts;
  }

  /**
   * Removes the first `n` messages (the ones that were just summarized).
   * Messages that arrived while summarizing stay in the queue.
   */
  removeFirst(n) {
    this.messages.splice(0, n);
    this.save();
  }

  clear() {
    const n = this.messages.length;
    this.messages = [];
    this.save();
    return n;
  }

  save() {
    this.json.write(this.messages);
  }
}

/**
 * The list of groups the bot watches. Each entry has the group name and,
 * once known, its WhatsApp ID, so a group keeps being watched after it is renamed.
 */
class GroupStore {
  /**
   * @param {string} file
   * @param {{ initialGroups?: string[], encryptionKey?: Buffer, logger?: object }} [options]
   */
  constructor(file, { initialGroups = [], encryptionKey, logger } = {}) {
    this.json = new JsonFile(file, { encryptionKey, logger });
    const loaded = this.json.read(null);
    if (Array.isArray(loaded)) {
      this.groups = loaded.filter((g) => g && (g.id || g.name));
    } else {
      this.groups = initialGroups.map((name) => ({ name }));
      if (this.groups.length) this.save();
    }
  }

  get count() {
    return this.groups.length;
  }

  list() {
    return this.groups.map((g) => ({ ...g }));
  }

  /**
   * Returns true if the chat is watched. Fills in a missing ID, or a new
   * name after a rename, so later checks keep working.
   * @param {{ id: string, name: string }} chat
   */
  matches(chat) {
    const entry =
      this.groups.find((g) => g.id && g.id === chat.id) ||
      this.groups.find((g) => !g.id && g.name === chat.name);
    if (!entry) return false;
    if (entry.id !== chat.id || entry.name !== chat.name) {
      entry.id = chat.id;
      entry.name = chat.name;
      this.save();
    }
    return true;
  }

  isWatched(chat) {
    return this.groups.some((g) => (g.id ? g.id === chat.id : g.name === chat.name));
  }

  /** @returns {boolean} false if it was already watched */
  add(chat) {
    if (this.isWatched(chat)) return false;
    this.groups.push({ id: chat.id, name: chat.name });
    this.save();
    return true;
  }

  /** @returns {boolean} false if it was not watched */
  remove(chat) {
    const before = this.groups.length;
    this.groups = this.groups.filter((g) => !(g.id ? g.id === chat.id : g.name === chat.name));
    if (this.groups.length === before) return false;
    this.save();
    return true;
  }

  save() {
    this.json.write(this.groups);
  }
}

/**
 * Keeps the latest N records (summaries or alerts) so other projects can
 * fetch them via the API. `limit` 0 keeps nothing on disk.
 */
class HistoryStore {
  /**
   * @param {string} file
   * @param {{ limit?: number, encryptionKey?: Buffer, logger?: object }} [options]
   */
  constructor(file, { limit = 30, encryptionKey, logger } = {}) {
    this.json = new JsonFile(file, { encryptionKey, logger });
    this.limit = limit;
    const loaded = this.json.read([]);
    this.items = limit > 0 && Array.isArray(loaded) ? loaded.slice(-limit) : [];
  }

  get count() {
    return this.items.length;
  }

  /**
   * @param {object} record
   * @returns {object} the stored record with id and createdAt
   */
  add(record) {
    const item = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...record };
    if (this.limit > 0) {
      this.items.push(item);
      if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
      this.json.write(this.items);
    }
    return item;
  }

  /** Newest first. */
  list(limit = this.limit) {
    return this.items.slice().reverse().slice(0, limit);
  }

  latest() {
    return this.items[this.items.length - 1] || null;
  }

  get(id) {
    return this.items.find((s) => s.id === id) || null;
  }
}

/**
 * Settings that can be changed at runtime (from WhatsApp or the API) and
 * survive restarts. Values not saved yet fall back to the .env defaults.
 */
class SettingsStore {
  /**
   * @param {string} file
   * @param {object} defaults
   * @param {{ encryptionKey?: Buffer, logger?: object }} [options]
   */
  constructor(file, defaults, { encryptionKey, logger } = {}) {
    this.json = new JsonFile(file, { encryptionKey, logger });
    this.defaults = defaults;
    const loaded = this.json.read({});
    this.saved = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
  }

  get(key) {
    return key in this.saved ? this.saved[key] : this.defaults[key];
  }

  all() {
    return { ...this.defaults, ...this.saved };
  }

  set(key, value) {
    this.saved[key] = value;
    this.json.write(this.saved);
  }
}

module.exports = { JsonFile, MessageStore, GroupStore, HistoryStore, SettingsStore };
