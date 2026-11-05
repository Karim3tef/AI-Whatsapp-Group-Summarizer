'use strict';

const crypto = require('crypto');

const ALG = 'aes-256-gcm';

/**
 * Parses DATA_ENCRYPTION_KEY: 64 hex characters or base64 of 32 bytes.
 * @param {string} value
 * @returns {Buffer}
 */
function parseKey(value) {
  const v = value.trim();
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(v)) key = Buffer.from(v, 'hex');
  else key = Buffer.from(v, 'base64');
  if (key.length !== 32) {
    throw new Error('must be 32 random bytes as 64 hex characters or base64 (run: npm run secret)');
  }
  return key;
}

/** Encrypts a string. Returns a JSON-friendly envelope. */
function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    encrypted: true,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function isEnvelope(value) {
  return Boolean(value && value.encrypted === true && value.alg && value.data);
}

/** Decrypts an envelope made by encrypt(). Throws if the key is wrong or data was changed. */
function decrypt(envelope, key) {
  if (envelope.alg !== ALG) throw new Error(`unsupported algorithm ${envelope.alg}`);
  const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
}

/** SHA-256 digest, used to compare secrets in constant time. */
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Constant-time check of `candidate` against a list of accepted secrets. */
function matchesAny(candidate, secrets) {
  if (!candidate) return false;
  const c = digest(candidate);
  let ok = false;
  for (const s of secrets) ok = crypto.timingSafeEqual(c, digest(s)) || ok;
  return ok;
}

/** HMAC-SHA256 signature in hex. */
const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

/** Random secret for API keys / webhook secrets / encryption keys. */
const randomSecret = (bytes = 32, encoding = 'hex') => crypto.randomBytes(bytes).toString(encoding);

module.exports = { parseKey, encrypt, decrypt, isEnvelope, matchesAny, sign, randomSecret };
