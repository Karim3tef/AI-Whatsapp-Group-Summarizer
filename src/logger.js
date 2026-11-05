'use strict';

/**
 * Tiny timestamped logger. pm2 and Docker already capture stdout/stderr,
 * so there is no need for a heavier logging library.
 */
function stamp() {
  return new Date().toISOString();
}

const logger = {
  info: (...args) => console.log(`[${stamp()}] INFO `, ...args),
  warn: (...args) => console.warn(`[${stamp()}] WARN `, ...args),
  error: (...args) => console.error(`[${stamp()}] ERROR`, ...args),
};

/** Logger that prints nothing. Handy for tests. */
const silentLogger = { info() {}, warn() {}, error() {} };

module.exports = { logger, silentLogger };
