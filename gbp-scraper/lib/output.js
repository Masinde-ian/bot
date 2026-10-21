'use strict';

const fs = require('fs');
const path = require('path');
const { ts, toCsvRow, log } = require('./utils');

const COLUMNS = [
  'title',
  'category',
  'address',
  'phone',
  'website',
  'email',
  'facebook',
  'instagram',
  'linkedin',
  'twitter',
  'youtube',
  'tiktok',
  'whatsapp',
  'plusCode',
  'rating',
  'reviewsCount',
  'hours',
  'reviews',
  'url',
  'scrapedAt',
  'lat',
  'lng',
  'distanceKm',
  'area',
  'areaMatch',
];

function flattenHours(hours) {
  if (!Array.isArray(hours) || !hours.length) return '';
  return hours
    .map((h) => `${h.day}: ${h.hours}`)
    .join(' | ')
    .replace(/\s*\n+\s*/g, ' ');
}

function flattenReviews(reviews) {
  if (!Array.isArray(reviews) || !reviews.length) return '';
  return reviews
    .map((r) => (r.rating ? `[${r.rating}] ${r.text}` : r.text))
    .filter(Boolean)
    .join(' ~ ')
    .replace(/\s*\n+\s*/g, ' ')
    .slice(0, 2000);
}

function flattenRecord(rec) {
  const email = Array.isArray(rec.email)
    ? rec.email.join('; ')
    : rec.email || '';
  return {
    title: rec.title || '',
    category: rec.category || '',
    address: rec.address || '',
    phone: rec.phone || '',
    website: rec.website || '',
    email,
    facebook: rec.facebook || '',
    instagram: rec.instagram || '',
    linkedin: rec.linkedin || '',
    twitter: rec.twitter || '',
    youtube: rec.youtube || '',
    tiktok: rec.tiktok || '',
    whatsapp: rec.whatsapp || '',
    plusCode: rec.plusCode || '',
    rating: rec.rating ?? '',
    reviewsCount: rec.reviewsCount ?? '',
    hours: flattenHours(rec.hours),
    reviews: flattenReviews(rec.reviews),
    url: rec.url || '',
    scrapedAt: rec.scrapedAt || '',
    lat: rec.lat ?? '',
    lng: rec.lng ?? '',
    distanceKm: rec.distanceKm ?? '',
    area: rec.area || '',
    areaMatch: rec.areaMatch === undefined ? '' : rec.areaMatch ? 'yes' : 'no',
  };
}

function createRun(outDir, { base, seed = [], meta = {} } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const name = base || `gbp_${ts()}`;
  const jsonlPath = path.join(outDir, `${name}.jsonl`);
  const jsonPath = path.join(outDir, `${name}.json`);
  const csvPath = path.join(outDir, `${name}.csv`);
  const metaPath = path.join(outDir, `${name}.meta.json`);
  const fsStream = fs.createWriteStream(jsonlPath, { flags: 'a' });
  const records = [...seed];
  const now = new Date().toISOString();
  const metaInfo = {
    base: name,
    query: meta.query || null,
    industry: meta.industry || null,
    place: meta.place || null,
    area: meta.area || null,
    options: meta.options || {},
    startedAt: meta.startedAt || now,
    updatedAt: now,
    sessions: meta.sessions || 1,
    finishedAt: null,
    count: records.length,
    status: 'running',
  };
  const writeMeta = (extra = {}) => {
    Object.assign(metaInfo, extra);
    try {
      fs.writeFileSync(metaPath, JSON.stringify(metaInfo, null, 2));
    } catch {
      /* meta is best-effort */
    }
  };
  writeMeta();

  return {
    base: name,
    jsonlPath,
    jsonPath,
    csvPath,
    metaPath,
    add(rec) {
      records.push(rec);
      fsStream.write(JSON.stringify(rec) + '\n');
      writeMeta({ count: records.length, updatedAt: new Date().toISOString() });
    },
    finalize({ status = 'done' } = {}) {
      return new Promise((resolve) => {
        fsStream.end(() => {
          fs.writeFileSync(jsonPath, JSON.stringify(records, null, 2));
          const header = COLUMNS.join(',');
          const rows = records.map((r) => toCsvRow(flattenRecord(r), COLUMNS));
          // BOM so Excel opens UTF-8 correctly
          fs.writeFileSync(
            csvPath,
            '\uFEFF' + [header, ...rows].join('\r\n') + '\r\n',
            'utf8'
          );
          writeMeta({ finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), count: records.length, status });
          log(`Saved ${records.length} records ->`);
          log(`  ${jsonPath}`);
          log(`  ${csvPath}`);
          resolve();
        });
      });
    },
    count: () => records.length,
  };
}

function loadCheckpoint(jsonlPath) {
  const done = new Set();
  const doneIds = new Set();
  const records = [];
  if (!fs.existsSync(jsonlPath)) return { done, doneIds, records };
  for (const line of fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.url) {
        done.add(rec.url);
        if (rec.placeId) doneIds.add(rec.placeId);
        records.push(rec);
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return { done, doneIds, records };
}

const SAFE_BASE_RE = /^[A-Za-z0-9._-]+$/;

function isSafeBase(name) {
  return (
    typeof name === 'string' &&
    SAFE_BASE_RE.test(name) &&
    !name.includes('..') &&
    !name.startsWith('.')
  );
}

// Enumerate runs in outDir, preferring *.meta.json sidecars and falling back to
// counting .jsonl/.json files for older runs.
function listRuns(outDir) {
  if (!fs.existsSync(outDir)) return [];
  const entries = fs.readdirSync(outDir);
  const runs = new Map();

  for (const file of entries) {
    if (file.endsWith('.meta.json')) {
      const base = file.slice(0, -'.meta.json'.length);
      if (!isSafeBase(base)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf8'));
        runs.set(base, {
          base,
          query: meta.query || null,
          industry: meta.industry || null,
          place: meta.place || null,
          count: meta.count || 0,
          status: meta.status || 'unknown',
          startedAt: meta.startedAt || null,
          updatedAt: meta.updatedAt || meta.finishedAt || null,
          sessions: meta.sessions || 1,
          finishedAt: meta.finishedAt || null,
        });
      } catch {
        /* skip bad meta */
      }
    }
  }

  for (const file of entries) {
    if (!file.endsWith('.jsonl')) continue;
    const base = file.slice(0, -'.jsonl'.length);
    if (!isSafeBase(base) || runs.has(base)) continue;
    let count = 0;
    try {
      const text = fs.readFileSync(path.join(outDir, file), 'utf8');
      count = text.split(/\r?\n/).filter((l) => l.trim()).length;
    } catch {
      /* ignore */
    }
    const stat = fs.statSync(path.join(outDir, file));
    runs.set(base, {
      base,
      query: null,
      industry: null,
      place: null,
      count,
      status: 'unknown',
      startedAt: stat.mtime.toISOString(),
      finishedAt: stat.mtime.toISOString(),
    });
  }

  return Array.from(runs.values()).sort((a, b) =>
    String(b.startedAt || '').localeCompare(String(a.startedAt || ''))
  );
}

function resolveRunFile(outDir, base, ext) {
  if (!isSafeBase(base)) throw new Error('Invalid run name');
  const p = path.join(outDir, `${base}${ext}`);
  if (!fs.existsSync(p)) throw new Error(`Run file not found: ${base}${ext}`);
  return p;
}

function readMeta(outDir, base) {
  if (!isSafeBase(base)) throw new Error('Invalid run name');
  const metaPath = path.join(outDir, `${base}.meta.json`);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function readRun(outDir, base) {
  if (!isSafeBase(base)) throw new Error('Invalid run name');
  const jsonPath = path.join(outDir, `${base}.json`);
  if (fs.existsSync(jsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
      /* fall through to jsonl */
    }
  }
  const { records } = loadCheckpoint(path.join(outDir, `${base}.jsonl`));
  return records;
}

module.exports = {
  createRun,
  loadCheckpoint,
  flattenRecord,
  listRuns,
  readRun,
  readMeta,
  resolveRunFile,
  isSafeBase,
  COLUMNS,
};
