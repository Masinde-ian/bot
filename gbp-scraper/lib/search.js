'use strict';

const { sleep, log, warn } = require('./utils');
const { handleConsent, isBlocked } = require('./browser');
const { placeKey } = require('./geo');

const END_OF_LIST = /reached the end of the list|no more results|end of the list/i;

// Google shows a "limited view" of the results and puts a "See more" button at
// the bottom of the feed. Clicking it unlocks the rest of the list.
const SEE_MORE_SELECTORS = [
  'button[aria-label="See more"]',
  'button.kyuRq',
  'div[role="feed"] button:has-text("See more")',
];

async function humanScroll(page, selector) {
  await page.evaluate(async (sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const atEnd = () => el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    let lastTop = -1;
    let stagnant = 0;
    while (stagnant < 3) {
      const step = 400 + Math.random() * 500;
      el.scrollTop += step;
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
      if (atEnd()) {
        // Google lazy-loads the next page when the feed is fully scrolled
        el.scrollTop = el.scrollHeight;
        await new Promise((r) => setTimeout(r, 1400));
        if (atEnd()) return;
      }
      if (el.scrollTop === lastTop) stagnant++;
      else stagnant = 0;
      lastTop = el.scrollTop;
    }
  }, selector);
}

async function feedSaysEndOfList(page) {
  return page
    .evaluate((re) => {
      const feed = document.querySelector('div[role="feed"]');
      if (!feed) return false;
      return new RegExp(re, 'i').test(feed.innerText || '');
    }, END_OF_LIST.source)
    .catch(() => false);
}

async function readListingLinks(page) {
  return page
    .$$eval('a[href*="/maps/place/"]', (els) => els.map((e) => e.href.split('?')[0]))
    .catch(() => []);
}

async function countLinks(page) {
  return page
    .$$eval('a[href*="/maps/place/"]', (els) => new Set(els.map((e) => e.href.split('?')[0])).size)
    .catch(() => 0);
}

async function clickSeeMore(page) {
  for (const selector of SEE_MORE_SELECTORS) {
    const btn = await page.$(selector);
    if (!btn) continue;
    try {
      await btn.scrollIntoViewIfNeeded({ timeout: 3000 });
      await btn.click({ timeout: 5000 });
      await sleep(1500);
      log('Clicked "See more" — Google released the full result list.');
      return true;
    } catch {
      /* try the next selector */
    }
  }
  return false;
}

// One growth step: scroll the feed to the end, and unlock the limited view
// when Google offers it.
async function growFeed(page) {
  const before = await countLinks(page);
  await humanScroll(page, 'div[role="feed"]');
  let after = await countLinks(page);
  if (after === before) {
    if (await clickSeeMore(page)) {
      await sleep(1500);
      await humanScroll(page, 'div[role="feed"]');
      after = await countLinks(page);
    }
  }
  return after > before;
}

// Collects every listing of a single search unit (one Google search page).
async function collectUnit(
  page,
  unit,
  { limit, allResults, delay, shouldStop, maxStagnant = 4 } = {}
) {
  const seen = new Set();
  const cap = allResults ? Infinity : limit;
  let stagnant = 0;
  let exhausted = false;

  await page.goto(unit.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  await handleConsent(page);

  try {
    await page.waitForSelector('div[role="feed"]', { timeout: 20000 });
  } catch {
    const feed = await page.$('div[role="feed"]');
    if (!feed) {
      if (await isBlocked(page)) {
        throw new Error(
          'Google served an "unusual traffic" wall. Wait a while, switch proxy, or run headed manually once.'
        );
      }
      throw new Error('Results feed (div[role="feed"]) never appeared.');
    }
  }

  while (true) {
    if (shouldStop()) break;
    const before = seen.size;
    const links = await readListingLinks(page);
    links.forEach((l) => seen.add(l));

    if (await feedSaysEndOfList(page)) {
      exhausted = true;
      break;
    }
    if (seen.size >= cap) break;

    const grew = await growFeed(page);
    if (grew) {
      stagnant = 0;
    } else {
      stagnant++;
      if (stagnant >= maxStagnant) break;
    }
    await delay();
  }

  if (await isBlocked(page)) {
    warn('Blocked by Google during collection.');
  }

  return { urls: Array.from(seen), exhausted };
}

// Runs every search unit and merges the results. A single Google search only
// returns a limited slice, so completeness comes from querying the area in
// several ways and unioning the results.
async function collectListingUrls(
  page,
  units,
  { limit = 20, allResults = false, delay, shouldStop = () => false, onUnit = null } = {}
) {
  const byKey = new Map();
  const stats = [];
  let exhausted = true;

  for (const unit of units) {
    if (shouldStop()) break;
    const result = await collectUnit(page, unit, {
      limit,
      allResults,
      delay,
      shouldStop,
    });

    let added = 0;
    for (const url of result.urls) {
      const key = placeKey(url);
      if (!byKey.has(key)) {
        byKey.set(key, url);
        added++;
      }
    }
    if (!result.exhausted) exhausted = false;

    const stat = {
      kind: unit.kind,
      label: unit.label,
      found: result.urls.length,
      added,
      unique: byKey.size,
      exhausted: result.exhausted,
    };
    stats.push(stat);
    log(
      `Search unit ${stats.length}/${units.length} · ${unit.label} · ${result.urls.length} found ` +
        `(+${added} new, ${byKey.size} unique)`
    );
    if (onUnit) onUnit(stat, stats.length, units.length);

    if (!allResults && byKey.size >= limit) break;
  }

  const all = Array.from(byKey.values());
  return {
    urls: allResults ? all : all.slice(0, limit),
    stats,
    exhausted,
  };
}

module.exports = { collectListingUrls, collectUnit, humanScroll, feedSaysEndOfList };
