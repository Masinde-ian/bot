'use strict';

const { sleep, log, warn } = require('./utils');
const { handleConsent } = require('./browser');

const EARTH_RADIUS_M = 6371008.8;
const METERS_PER_DEG = 111320;
// Conservative smaller edge of the Maps viewport (window 1366x900 minus the
// results panel) — used to pick a tile zoom that cannot leave gaps.
const VIEWPORT_PX = 700;
const MAX_TILES = 64;

const GENERIC_AREA_WORDS = new Set([
  'road', 'rd', 'street', 'st', 'avenue', 'ave', 'lane', 'drive', 'dr',
  'close', 'way', 'place', 'district', 'ward', 'area', 'region', 'city',
  'town', 'county', 'suburb', 'suburbia', 'neighbourhood', 'neighborhood',
  'junction', 'centre', 'center', 'estate', 'gated', 'north', 'south',
  'east', 'west', 'central', 'inner', 'outer', 'upper', 'lower', 'the',
  'and', 'of', 'near', 'opposite', 'at',
]);

const STREET_SUFFIXES = ['rd', 'road', 'street', 'st', 'avenue', 'ave', 'drive', 'lane', 'way'];

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(a, b) {
  if (!a || !b) return null;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return (2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))) / 1000;
}

// Google encodes a place's exact position in the link: `/@lat,lng,zoomz` and
// `data=!3d<lat>!4d<lng>`. The `!1d/!2d` pair is only the viewport centre, so
// it is the last resort.
const COORD_PATTERNS = [
  { re: /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, lat: 1, lng: 2, source: 'data' },
  { re: /\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/, lat: 1, lng: 2, source: 'at' },
  { re: /\/place\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, lat: 1, lng: 2, source: 'place' },
  {
    re: /[?&](?:q|center|centre|ll|destination|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    lat: 1,
    lng: 2,
    source: 'query',
  },
  { re: /!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/, lat: 2, lng: 1, source: 'viewport' },
];

function parsePlaceCoords(rawUrl) {
  if (!rawUrl) return null;
  const url = String(rawUrl);
  for (const { re, lat: latIdx, lng: lngIdx, source } of COORD_PATTERNS) {
    const m = re.exec(url);
    if (!m) continue;
    const lat = parseFloat(m[latIdx]);
    const lng = parseFloat(m[lngIdx]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    return { lat, lng, source };
  }
  return null;
}

// Stable identity for a place so the same business found through two different
// tiles (or two different runs) is only scraped once.
function placeKey(rawUrl) {
  const url = String(rawUrl || '');
  const ftid = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(url);
  if (ftid) return `ftid:${ftid[1].toLowerCase()}`;
  const cid = /[?&]cid=(\d+)/.exec(url);
  if (cid) return `cid:${cid[1]}`;
  const coords = parsePlaceCoords(url);
  if (coords) return `geo:${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}`;
  const slug = /\/maps\/place\/([^?#/]+)/.exec(url);
  if (slug) return `slug:${decodeURIComponent(slug[1]).toLowerCase()}`;
  return `url:${url.split('?')[0].toLowerCase()}`;
}

// Zoom where the viewport edge is ~tileKm wide.
function zoomForTile(lat, tileMeters, viewportPx = VIEWPORT_PX) {
  const cos = Math.max(0.05, Math.cos(toRad(lat)));
  const z = Math.log2((156543.03392 * cos * viewportPx) / Math.max(50, tileMeters));
  return clamp(Math.round(z), 12, 18);
}

// Grid of tile centres covering the radius around the area centre.
function tileGrid({ lat, lng, radiusKm, tileKm }) {
  const cos = Math.max(0.05, Math.cos(toRad(lat)));
  const stepLat = tileKm / METERS_PER_DEG;
  const stepLng = tileKm / (METERS_PER_DEG * cos);
  const rows = Math.max(1, Math.ceil((radiusKm * 2) / 111320 / stepLat));
  const cols = Math.max(1, Math.ceil((radiusKm * 2) / (111320 * cos) / stepLng));

  const tiles = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (tiles.length >= MAX_TILES) return tiles;
      const tLat = lat + (j - (rows - 1) / 2) * stepLat;
      const tLng = lng + (i - (cols - 1) / 2) * stepLng;
      tiles.push({ lat: tLat, lng: tLng, i, j, zoom: zoomForTile(tLat, tileKm * 1000) });
    }
  }
  return tiles;
}

function parseHashOrUrlCoords(url) {
  const m = /\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z/.exec(String(url || ''));
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, zoom: parseInt(m[3], 10) };
}

async function waitForUrlCoords(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const coords = parseHashOrUrlCoords(page.url());
    if (coords) {
      if (last && last.lat === coords.lat && last.lng === coords.lng) return coords;
      last = coords;
    }
    await sleep(600);
  }
  return last;
}

// Resolves a free-text area (street, road, district, neighbourhood) to a map
// centre without needing an API key.
async function geocodeArea(page, place, { timeout = 25000 } = {}) {
  const q = encodeURIComponent(String(place || '').trim());
  if (!q) return null;

  try {
    await page.goto(`https://www.google.com/maps/search/${q}?hl=en`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(1200);
    await handleConsent(page);
    const coords = await waitForUrlCoords(page, timeout);
    if (coords) {
      log(`Area "${place}" resolved to ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`);
      return { ...coords, source: 'maps' };
    }
  } catch (e) {
    warn(`Area lookup failed (${e.message}) — trying embed fallback.`);
  }

  try {
    const resp = await page.goto(`https://maps.google.com/maps?q=${q}&output=embed`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const html = await resp.text();
    const ll = /ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(html);
    if (ll) {
      const zoom = /[?&]z=(\d+)/.exec(html) || /"z":(\d+)/.exec(html);
      const center = {
        lat: parseFloat(ll[1]),
        lng: parseFloat(ll[2]),
        zoom: zoom ? parseInt(zoom[1], 10) : 14,
        source: 'embed',
      };
      log(
        `Area "${place}" resolved to ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)} (embed)`
      );
      return center;
    }
  } catch (e) {
    warn(`Area embed lookup failed: ${e.message}`);
  }

  return null;
}

// Google sometimes lists the named sub-areas of an area (Upper Hill, Lower
// Hill…). Each one is a genuine "registered under this area" feed.
async function discoverSubAreas(page, areaPlace, limit = 8) {
  const links = await page
    .$$eval('a[href*="/maps/search/"]', (els) =>
      els.map((e) => ({ href: e.href, text: (e.innerText || '').replace(/\s+/g, ' ').trim() }))
    )
    .catch(() => []);

  const seen = new Set();
  const out = [];
  const base = String(areaPlace || '').trim().toLowerCase();
  for (const l of links) {
    const text = l.text;
    if (!text || text.length < 3 || text.length > 60) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    if (base && key === base) continue;
    if (!/[a-z]/i.test(text)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

// Address tokens for the area, derived from the first segment only so that a
// trailing city ("Westlands, Nairobi") does not match every listing in town.
function areaTokens(areaText) {
  const primary = String(areaText || '').split(',')[0].trim();
  if (!primary) return [];
  const words = primary
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean);
  const specific = words.filter((w) => w.length >= 4 && !GENERIC_AREA_WORDS.has(w));
  const tokens = new Set();
  if (specific.length) {
    for (const w of specific) {
      tokens.add(w);
      for (const suffix of STREET_SUFFIXES) tokens.add(`${w} ${suffix}`);
    }
    if (specific.length > 1) tokens.add(specific.join(' '));
  } else {
    tokens.add(primary.toLowerCase());
  }
  return Array.from(tokens);
}

function normalizeAddress(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addressMatchesArea(address, tokens) {
  if (!address || !tokens || !tokens.length) return false;
  const hay = normalizeAddress(address);
  return tokens.some((t) => hay.includes(t));
}

module.exports = {
  haversineKm,
  parsePlaceCoords,
  placeKey,
  zoomForTile,
  tileGrid,
  geocodeArea,
  discoverSubAreas,
  areaTokens,
  addressMatchesArea,
  parseHashOrUrlCoords,
  clamp,
  MAX_TILES,
};
