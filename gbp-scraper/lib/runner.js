'use strict';

const fs = require('fs');
const path = require('path');
const bus = require('./events');
const { makeDelay, parseDelay, log, warn, sleep } = require('./utils');
const { launchBrowser, loadProxies, ProxyPool, isBlocked } = require('./browser');
const { collectListingUrls } = require('./search');
const { extractDetailWithRetry } = require('./detail');
const { discoverContacts } = require('./contact');
const { createRun, loadCheckpoint, readMeta, isSafeBase } = require('./output');
const {
  geocodeArea,
  discoverSubAreas,
  tileGrid,
  haversineKm,
  parsePlaceCoords,
  placeKey,
  areaTokens,
  addressMatchesArea,
  clamp,
} = require('./geo');
const { handleConsent } = require('./browser');

let jobCounter = 0;
let activeJob = null;

// Safety cap on how many listings we collect from Google in one session.
const MAX_COLLECT = 5000;

// Resolve a resume/continue target into { path, outDir, base, meta } or null.
function resolveResume(opts) {
  if (opts.continueBase) {
    if (!isSafeBase(opts.continueBase)) throw new Error('Invalid run name to continue');
    const outDir = opts.outDir || path.join(process.cwd(), 'output');
    const jsonlPath = path.join(outDir, `${opts.continueBase}.jsonl`);
    if (!fs.existsSync(jsonlPath)) throw new Error(`Run not found: ${opts.continueBase}`);
    return {
      path: jsonlPath,
      outDir,
      base: opts.continueBase,
      meta: readMeta(outDir, opts.continueBase),
    };
  }
  if (opts.resume) {
    const resumePath = path.resolve(opts.resume);
    const outDir = path.dirname(resumePath);
    const base = path.basename(resumePath, '.jsonl');
    return { path: resumePath, outDir, base, meta: readMeta(outDir, base) };
  }
  return null;
}

function getActiveJob() {
  return activeJob;
}

function buildQuery({ query, industry, place }) {
  if (query && query.trim()) return query.trim();
  const i = (industry || '').trim();
  const p = (place || '').trim();
  if (i && p) return `${i} in ${p}`;
  return i || p;
}

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeArea(raw) {
  if (!raw || !raw.enabled) return null;
  const place = String(raw.place || '').trim();
  const lat = numOrNull(raw.lat);
  const lng = numOrNull(raw.lng);
  if (!place && lat === null) return null;
  return {
    enabled: true,
    place,
    radiusKm: clamp(numOrNull(raw.radiusKm) ?? 3, 0.2, 25),
    tileKm: clamp(numOrNull(raw.tileKm) ?? 2, 0.5, 5),
    lat,
    lng,
    zoom: numOrNull(raw.zoom),
    subAreas: !!raw.subAreas,
    keepOutside: !!raw.keepOutside,
  };
}

function areaTolerance(area) {
  return Math.max(0.25, area.radiusKm * 0.15);
}

// Runs one scrape job. Emits events on the shared bus with a `jobId` tag and
// also buffers them on the returned controller for late SSE subscribers.
function runScrapeJob(opts = {}) {
  if (activeJob) {
    throw new Error('A scrape job is already running');
  }

  const id = `job_${Date.now()}_${++jobCounter}`;
  const resume = resolveResume(opts);
  let query = buildQuery(opts);
  if (resume && resume.meta && resume.meta.query) query = resume.meta.query;
  if (!query && !(opts.area && opts.area.enabled)) throw new Error('A query (industry and/or place) is required');

  const allResults = !!opts.allResults;
  const area = normalizeArea(opts.area);
  const max = allResults ? MAX_COLLECT : Math.max(1, parseInt(opts.max, 10) || 20);
  const [delayMin, delayMax] = parseDelay(
    typeof opts.delay === 'string' ? opts.delay : opts.delayStr,
    opts.delayMin ?? 800,
    opts.delayMax ?? 2400
  );
  const delay = makeDelay(delayMin, delayMax);
  const withContacts = opts.contact !== false;
  const headless = !!opts.headless;

  const controller = {
    id,
    query,
    max,
    allResults,
    area,
    stopped: false,
    state: 'starting',
    done: 0,
    total: 0,
    records: [],
    events: [],
    bufferLimit: 5000,
    promise: null,
    stop() {
      if (controller.stopped) return;
      controller.stopped = true;
      emit({ type: 'stage', stage: 'stopping', message: 'Stop requested' });
      if (browser) {
        try {
          browser.close();
        } catch {
          /* ignore */
        }
      }
    },
  };

  function emit(event) {
    const e = { jobId: id, seq: controller.events.length, ts: new Date().toISOString(), ...event };
    controller.events.push(e);
    if (controller.events.length > controller.bufferLimit) {
      controller.events.splice(0, controller.events.length - controller.bufferLimit);
    }
    bus.emit('job', e);
  }

  let browser = null;
  let context = null;
  let page = null;
  let pool = new ProxyPool([]);
  let run = null;
  let listingsDone = 0;
  const ROTATE_EVERY = 25;

  async function start() {
    const launched = await launchBrowser({ headless, proxy: pool.current() });
    ({ browser, context, page } = launched);
    emit({ type: 'stage', stage: 'browser', message: `Browser launched (headless=${headless})` });
  }

  async function restart() {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    pool.rotate();
    await start();
  }

  // Builds the list of Google searches to run. We cast a wide net across
  // name variants because each single query is capped (~60-80 visible results
  // even after "See more"), and viewport-pinning doesn't localize reliably.
  async function buildUnits() {
    const units = [];
    const term = (opts.industry || query).trim();
    const placeName = (opts.place || '').trim() || (area && area.place ? area.place : '').trim();
    const areaPlace = area && area.place ? area.place.trim() : placeName;

    if (areaPlace) {
      if (term) {
        units.push({
          kind: 'text',
          label: `"${term} in ${areaPlace}"`,
          url: `https://www.google.com/maps/search/${encodeURIComponent(`${term} in ${areaPlace}`)}?hl=en`,
        });
        units.push({
          kind: 'text',
          label: `"${term} near ${areaPlace}"`,
          url: `https://www.google.com/maps/search/${encodeURIComponent(`${term} near ${areaPlace}`)}?hl=en`,
        });
        const short = areaPlace.split(',')[0].trim();
        if (short && short.toLowerCase() !== areaPlace.toLowerCase()) {
          units.push({
            kind: 'text',
            label: `"${term} in ${short}"`,
            url: `https://www.google.com/maps/search/${encodeURIComponent(`${term} in ${short}`)}?hl=en`,
          });
          units.push({
            kind: 'text',
            label: `"${term} near ${short}"`,
            url: `https://www.google.com/maps/search/${encodeURIComponent(`${term} near ${short}`)}?hl=en`,
          });
        }
      } else {
        units.push({
          kind: 'text',
          label: `"${areaPlace}"`,
          url: `https://www.google.com/maps/search/${encodeURIComponent(areaPlace)}?hl=en`,
        });
      }

      if (area && area.subAreas) {
        try {
          const center = area.lat !== null && area.lng !== null ? { lat: area.lat, lng: area.lng } : null;
          if (!center && areaPlace) {
            const resp = await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(areaPlace)}?hl=en`, {
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            });
            if (resp) await page.waitForTimeout(2000);
            await handleConsent(page);
          }
          const subs = await discoverSubAreas(page, areaPlace);
          for (const sub of subs) {
            const q = term ? `${term} in ${sub}` : sub;
            units.push({
              kind: 'subarea',
              label: `Sub-area "${sub}"`,
              url: `https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=en`,
            });
          }
          if (subs.length) {
            emit({ type: 'stage', stage: 'area', message: `Sub-areas found: ${subs.join(', ')}` });
          }
        } catch {
          /* best effort */
        }
      }

      if (term) {
        units.push({
          kind: 'text',
          label: `Broad "${term} in ${areaPlace.split(',').pop().trim()}"`,
          url: `https://www.google.com/maps/search/${encodeURIComponent(`${term} in ${areaPlace.split(',').pop().trim()}`)}?hl=en`,
        });
      }
    }

    if (!units.length) {
      units.push({
        kind: 'text',
        label: `Search "${query}"`,
        url: `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`,
      });
    }

    // dedupe units by URL
    const seen = new Set();
    return units.filter((u) => {
      const k = u.url;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  controller.promise = (async () => {
    let status = 'done';
    try {
      pool = new ProxyPool(
        loadProxies({ proxy: opts.proxy, proxyFile: opts.proxyFile })
      );
      emit({ type: 'stage', stage: 'launching', message: `Using proxy: ${pool.label()}` });
      await start();

      if (resume) {
        const { done, doneIds, records } = loadCheckpoint(resume.path);
        controller.seen = done;
        controller.seenIds = doneIds;
        for (const rec of records) {
          if (rec.url) controller.seenIds.add(placeKey(rec.url));
        }
        controller.done = records.length;
        controller.records = [...records];
        emit({
          type: 'stage',
          stage: 'resuming',
          message: `Continuing "${resume.base}" (${records.length} already scraped)`,
        });
        run = createRun(resume.outDir, {
          base: resume.base,
          seed: records,
          meta: {
            query,
            industry: opts.industry || (resume.meta && resume.meta.industry),
            place: opts.place || (resume.meta ? resume.meta.place : undefined),
            options: summarize(opts),
            startedAt: resume.meta ? resume.meta.startedAt : undefined,
            sessions: ((resume.meta && resume.meta.sessions) || 1) + 1,
          },
        });
      } else {
        run = createRun(opts.outDir, {
          meta: {
            query,
            industry: opts.industry,
            place: opts.place,
            area: area
              ? {
                  place: area.place,
                  radiusKm: area.radiusKm,
                  tileKm: area.tileKm,
                  subAreas: area.subAreas,
                }
              : null,
            options: summarize(opts),
          },
        });
      }
      controller.base = run.base;
      emit({
        type: 'stage',
        stage: 'searching',
        message: `Searching: "${query}"${allResults ? ' (all results)' : ` (max ${max})`}`,
        base: run.base,
      });

      const placeName = (opts.place || '').trim() || (area && area.place ? area.place : '').trim();
      const areaPlace = area && area.place ? area.place.trim() : placeName;

      const skippedCount = controller.seen ? controller.seen.size : 0;
      const collectTarget = allResults ? MAX_COLLECT : Math.min(MAX_COLLECT, skippedCount + max);
      const units = await buildUnits();
      controller.areaUnits = units.map((u) => ({ kind: u.kind, label: u.label }));
      const collected = await collectListingUrls(page, units, {
        limit: collectTarget,
        allResults,
        delay,
        shouldStop: () => controller.stopped,
        onUnit: (stat, i, total) =>
          emit({
            type: 'stage',
            stage: 'unit',
            message:
              `Search ${i}/${total} · ${stat.label} · ${stat.found} found ` +
              `(+${stat.added} new · ${stat.unique} unique${stat.exhausted ? ' · end of list' : ''})`,
          }),
      });

      if (area && areaPlace) {
        try {
          if (area.lat !== null && area.lng !== null) {
            controller.areaCenter = { lat: area.lat, lng: area.lng, source: 'manual' };
          } else {
            controller.areaCenter = await geocodeArea(page, areaPlace);
          }
          if (controller.areaCenter) {
            controller.areaTokens = areaTokens(areaPlace);
          }
        } catch {
          /* ignore */
        }
      }

      let candidates = collected.urls;
      let outsideBefore = 0;
      if (area && controller.areaCenter) {
        const tol = areaTolerance(area);
        const kept = [];
        for (const url of candidates) {
          const coords = parsePlaceCoords(url);
          if (!coords) {
            kept.push(url);
            continue;
          }
          const d = haversineKm(controller.areaCenter, coords);
          if (d !== null && d <= area.radiusKm + tol) kept.push(url);
          else outsideBefore++;
        }
        candidates = kept;
        emit({
          type: 'stage',
          stage: 'area',
          message:
            `Area filter: ${kept.length} within ${area.radiusKm} km of ${areaPlace}, ` +
            `${outsideBefore} outside`,
        });
      }

      const fresh = candidates.filter(
        (u) => !(controller.seen && controller.seen.has(u)) && !(controller.seenIds && controller.seenIds.has(placeKey(u)))
      );
      const targets = fresh.slice(0, max);
      controller.total = targets.length;
      controller.state = 'scraping';
      emit({
        type: 'found',
        total: targets.length,
        collected: collected.urls.length,
        skipped: skippedCount,
        fresh: fresh.length,
        outsideArea: outsideBefore,
        exhausted: collected.exhausted,
        units: collected.stats.length,
      });

      let droppedOutside = 0;

      for (let i = 0; i < targets.length; i++) {
        if (controller.stopped) break;
        const url = targets[i];

        if (pool.enabled && listingsDone > 0 && listingsDone % ROTATE_EVERY === 0) {
          emit({ type: 'stage', stage: 'proxy', message: `Rotating proxy after ${listingsDone} listings` });
          await restart();
        }

        emit({ type: 'progress', index: i + 1, total: targets.length, current: url });

        try {
          if (await isBlocked(page)) {
            warn('Unusual-traffic wall detected. Pausing 60s...');
            emit({ type: 'stage', stage: 'blocked', message: 'Unusual-traffic wall; pausing 60s' });
            await sleep(60000);
            if (controller.stopped) break;
            if (pool.enabled) await restart();
          }

          const record = await extractDetailWithRetry(page, url, delay);

          if (withContacts && record.website) {
            record.contact = await discoverContacts(page, record);
            record.email = record.contact.email;
            Object.assign(record, {
              facebook: record.contact.facebook,
              instagram: record.contact.instagram,
              linkedin: record.contact.linkedin,
              twitter: record.contact.twitter,
              youtube: record.contact.youtube,
              tiktok: record.contact.tiktok,
              whatsapp: record.contact.whatsapp,
            });
          } else {
            record.email = [];
          }

          record.placeId = placeKey(url);
          if (record.lat === undefined || record.lat === null) {
            const coords = parsePlaceCoords(url);
            if (coords) {
              record.lat = coords.lat;
              record.lng = coords.lng;
            }
          }

      if (area && controller.areaCenter) {
        const tol = areaTolerance(area);
        const coords =
          record.lat !== undefined && record.lat !== null
            ? { lat: record.lat, lng: record.lng }
            : null;
        const d = coords ? haversineKm(controller.areaCenter, coords) : null;
        if (d !== null) record.distanceKm = Math.round(d * 100) / 100;
        const inside =
          (d !== null && d <= area.radiusKm + tol) ||
          addressMatchesArea(record.address, controller.areaTokens);
        record.areaMatch = inside;
        record.area = areaPlace;
        if (!inside && !area.keepOutside) {
          droppedOutside++;
          emit({
            type: 'stage',
            stage: 'area',
            message: `Outside "${areaPlace}": ${record.title || '(no title)'} (${record.distanceKm ?? '?'} km)`,
          });
          continue;
        }
      }


          run.add(record);
          controller.records.push(record);
          listingsDone++;
          controller.done = controller.records.length;
          emit({ type: 'record', index: i + 1, total: targets.length, record });
          log(`[${i + 1}/${targets.length}] ${record.title || '(no title)'}`);
        } catch (e) {
          if (controller.stopped) break;
          warn(`Listing failed: ${e.message}`);
          emit({ type: 'error', index: i + 1, total: targets.length, message: e.message });
        }

        await delay();
      }

      if (droppedOutside) {
        emit({
          type: 'stage',
          stage: 'area',
          message: `${droppedOutside} listings dropped because they sit outside "${areaPlace}"`,
        });
      }
      if (controller.stopped) status = 'stopped';
    } catch (e) {
      if (controller.stopped) {
        status = 'stopped';
      } else {
        status = 'error';
        controller.state = 'error';
        emit({ type: 'error', message: e.message || String(e) });
        console.error(e);
      }
    } finally {
      try {
        if (run) await run.finalize({ status });
      } catch (e) {
        warn(`finalize failed: ${e.message}`);
      }
      try {
        if (browser) await browser.close();
      } catch {
        /* ignore */
      }
      controller.state = status;
      controller.finishedAt = new Date().toISOString();
      emit({
        type: 'done',
        status,
        count: controller.records.length,
        base: controller.base || null,
      });
      if (activeJob === controller) activeJob = null;
    }
    return controller;
  })();

  activeJob = controller;
  return controller;
}

function summarize(opts) {
  return {
    max: opts.max,
    allResults: !!opts.allResults,
    headless: !!opts.headless,
    contact: opts.contact !== false,
    proxy: opts.proxy ? true : false,
    proxyFile: opts.proxyFile || null,
    delayMin: opts.delayMin ?? null,
    delayMax: opts.delayMax ?? null,
    area: opts.area && opts.area.enabled
      ? {
          place: opts.area.place || null,
          radiusKm: opts.area.radiusKm ?? null,
          tileKm: opts.area.tileKm ?? null,
          subAreas: !!opts.area.subAreas,
        }
      : null,
  };
}

module.exports = { runScrapeJob, getActiveJob, buildQuery, normalizeArea };
