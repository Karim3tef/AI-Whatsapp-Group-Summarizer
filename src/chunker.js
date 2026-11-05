'use strict';

/**
 * Splits text into chunks of at most `size` characters, breaking on line
 * boundaries so a message is never cut in half. A single line longer than
 * `size` is the only thing that gets split mid-line.
 *
 * @param {string} text
 * @param {number} size
 * @returns {string[]}
 */
function splitText(text, size) {
  if (!Number.isFinite(size) || size < 1) throw new Error('size must be a positive number');
  const chunks = [];
  let cur = '';

  const push = () => {
    if (cur) chunks.push(cur);
    cur = '';
  };

  for (const rawLine of text.split('\n')) {
    let line = rawLine + '\n';

    // Line alone is too big: flush what we have, then hard-split it.
    while (line.length > size) {
      push();
      chunks.push(line.slice(0, size));
      line = line.slice(size);
    }

    if (cur.length + line.length > size) push();
    cur += line;
  }
  push();

  return chunks.map((c) => c.replace(/\n$/, '')).filter((c) => c.length > 0);
}

module.exports = { splitText };
