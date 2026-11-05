#!/usr/bin/env node
'use strict';

// Prints a strong random secret (32 bytes as hex). Use it for API_KEYS,
// WEBHOOK_SECRET or DATA_ENCRYPTION_KEY.
//
//   npm run secret
//   npm run secret -- 3      (prints 3 secrets)

const { randomSecret } = require('../src/crypto');

const count = Math.min(Math.max(Number(process.argv[2]) || 1, 1), 20);
for (let i = 0; i < count; i++) console.log(randomSecret());
