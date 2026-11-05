'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Fresh temp directory, removed when the test ends. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-summarizer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const noSleep = async () => {};

module.exports = { tempDir, noSleep };
