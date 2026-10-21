'use strict';

const bus = require('./events');

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDelay(minMs, maxMs) {
  return () => sleep(rand(minMs, maxMs));
}

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

function emitLog(level, args) {
  const message = args
    .map((a) => (a instanceof Error ? a.message : String(a)))
    .join(' ');
  bus.emit('log', { type: 'log', level, message, ts: new Date().toISOString() });
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
  emitLog('info', args);
}

function warn(...args) {
  console.warn(`[${new Date().toISOString()}] WARN:`, ...args);
  emitLog('warn', args);
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsvRow(obj, columns) {
  return columns.map((c) => csvEscape(obj[c])).join(',');
}

// Strips icon glyphs (Google's material-symbols render as private-use chars),
// control chars and stray leading/trailing whitespace from innerText values.
function cleanText(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/[\uE000-\uF8FF\uFFF0-\uFFFF]/g, '') // PUA icon glyphs
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function parseDelay(spec, fallbackMin = 800, fallbackMax = 2400) {
  if (!spec) return [fallbackMin, fallbackMax];
  const m = String(spec).match(/^(\d+)(?::(\d+))?$/);
  if (!m) return [fallbackMin, fallbackMax];
  const min = parseInt(m[1], 10);
  const max = m[2] !== undefined ? parseInt(m[2], 10) : min;
  return [Math.min(min, max), Math.max(min, max)];
}

module.exports = {
  rand,
  sleep,
  makeDelay,
  ts,
  log,
  warn,
  csvEscape,
  toCsvRow,
  parseDelay,
  cleanText,
};
