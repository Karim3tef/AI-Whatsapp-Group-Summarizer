'use strict';

/**
 * How the bot reports:
 *  - schedule: one summary at the times in SCHEDULE
 *  - realtime: an alert as soon as an important message shows up
 *  - both:     real-time alerts plus the scheduled summary
 */
const MODES = ['schedule', 'realtime', 'both'];

const MODE_NAMES_AR = { schedule: 'مجدول', realtime: 'فوري', both: 'الاتنين' };

const usesSchedule = (mode) => mode === 'schedule' || mode === 'both';
const usesRealtime = (mode) => mode === 'realtime' || mode === 'both';

/** Accepts English or Arabic names. Returns null if unknown. */
function parseMode(value) {
  const v = String(value || '').trim().toLowerCase();
  if (MODES.includes(v)) return v;
  const ar = { مجدول: 'schedule', ميعاد: 'schedule', فوري: 'realtime', لحظي: 'realtime', الاتنين: 'both', الاثنين: 'both', الكل: 'both' };
  return ar[v] || null;
}

/** "23:00-07:00" -> { start: 1380, end: 420 } in minutes of the day, or null if invalid. */
function parseQuietHours(value) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const start = h1 * 60 + m1;
  const end = h2 * 60 + m2;
  return start === end ? null : { start, end, text: value.trim() };
}

/** Minutes since midnight in the given time zone. */
function minutesInZone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get('hour') * 60 + get('minute');
}

/** True if `date` falls inside the quiet window (which may cross midnight). */
function isQuiet(quiet, timezone, date = new Date()) {
  if (!quiet) return false;
  const now = minutesInZone(date, timezone);
  return quiet.start < quiet.end ? now >= quiet.start && now < quiet.end : now >= quiet.start || now < quiet.end;
}

module.exports = { MODES, MODE_NAMES_AR, usesSchedule, usesRealtime, parseMode, parseQuietHours, isQuiet, minutesInZone };
