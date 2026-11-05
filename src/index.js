'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const { loadConfig } = require('./config');
const { createBot } = require('./bot');
const { logger } = require('./logger');

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  logger.error(err.message);
  logger.error('Copy .env.example to .env and fill it in. See README.md.');
  process.exit(1);
}

const bot = createBot(config, logger);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`${signal} received, shutting down...`);
  await bot.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error('Unhandled rejection:', err && err.message ? err.message : err));

logger.info('Starting AI WhatsApp Group Summarizer...');
bot.start().catch((err) => {
  logger.error('Failed to start WhatsApp client:', err.message);
  process.exit(1);
});
