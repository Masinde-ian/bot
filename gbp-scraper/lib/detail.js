'use strict';

const { sleep, warn, cleanText } = require('./utils');
const { parsePlaceCoords } = require('./geo');

async function firstText(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const text = cleanText(await el.innerText().catch(() => ''));
      if (text) return text;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function firstAttr(page, selectors, attr) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const v = await el.getAttribute(attr);
      if (v) return v;
    } catch {
      /* try next */
    }
  }
  return null;
}

// The header rating is a [role="img"] element labelled "4.6 stars " and the
// review count is a separate element labelled "618 reviews". Histogram rows are
// labelled "5 stars, 476 reviews" and individual review stars are "5 stars" —
// so anchor on the exact shapes and take the first match.
async function extractRating(page) {
  const labels = await page
    .$$eval('[aria-label]', (els) =>
      els.map((e) => e.getAttribute('aria-label')).filter(Boolean)
    )
    .catch(() => []);

  const out = {};
  for (const label of labels) {
    if (out.rating === undefined) {
      const m = label.match(/^\s*([\d.]+)\s+stars?\s*$/i);
      if (m) out.rating = parseFloat(m[1]);
    }
    if (out.reviewsCount === undefined) {
      const m = label.match(/^\s*([\d,]+)\s+reviews?\s*$/i);
      if (m) out.reviewsCount = parseInt(m[1].replace(/,/g, ''), 10);
    }
    if (out.rating !== undefined && out.reviewsCount !== undefined) break;
  }
  return out;
}

const WEEKDAY_RE = /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day/i;

async function extractHours(page) {
  const hoursBtn = await page.$(
    'button[data-item-id="oh"], div[jsaction*="openhours"], span[jsaction*="openhours"]'
  );
  const readTables = () =>
    page.$$eval('table', (tables) => {
      const rowsOf = (tbl) =>
        Array.from(tbl.querySelectorAll('tr'))
          .map((r) => {
            const cells = r.querySelectorAll('td, th');
            if (cells.length < 2) return null;
            const day = cells[0].innerText.trim();
            const hrs = cells[1].innerText.trim();
            return day && hrs ? { day, hours: hrs } : null;
          })
          .filter(Boolean);
      for (const t of tables) {
        const rows = rowsOf(t);
        if (rows.length >= 3) return rows;
      }
      return null;
    });

  let opened = false;
  try {
    if (hoursBtn) {
      await hoursBtn.click();
      opened = true;
      await sleep(900);
    }
    const hours = await readTables();

    // The hours button opens a sub-view that replaces the overview panel.
    // Navigate back so reviews/details remain available afterwards.
    if (opened) {
      const back = await page.$('button[aria-label*="Back" i], button[jsaction*="back"]');
      if (back) {
        await back.click();
        await sleep(1200);
      } else {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(500);
      }
    }

    if (hours && hours.length >= 3) {
      return hours
        .filter((h) => WEEKDAY_RE.test(cleanText(h.day)))
        .map((h) => ({ day: cleanText(h.day), hours: cleanText(h.hours) }));
    }
  } catch (e) {
    warn(`hours extraction failed: ${e.message}`);
  }
  return null;
}

async function collectReviews(page, { min = 3, maxWait = 5000 } = {}) {
  const deadline = Date.now() + maxWait;
  let uniq = 0;
  while (Date.now() < deadline) {
    uniq = await page
      .$$eval('[data-review-id]', (els) => new Set(els.map((e) => e.getAttribute('data-review-id'))).size)
      .catch(() => 0);
    if (uniq >= min) break;
    await sleep(500);
  }
  // The inline panel often previews only 2-3 reviews; open the Reviews tab for more
  if (uniq > 0 && uniq < 5) {
    const tab = await page.$(
      'button[jsaction*="moreReviews"], button[aria-label="Reviews"], button[aria-label*="Reviews" i]'
    );
    if (tab) {
      try {
        await tab.click();
        await sleep(2500);
      } catch {
        /* ignore */
      }
    }
  }
  return extractReviews(page);
}

async function extractReviews(page) {
  return page
    .$$eval('div[data-review-id]', (els) => {
      const seen = new Set();
      const out = [];
      const stripMore = (t) =>
        t
          .replace(/\s*(?:…|\.\.\.)?\s*(?:Zaidi|More)$/i, '')
          .replace(/\s*(?:…|\.\.\.)$/, '')
          .trim();
      for (const el of els) {
        if (out.length >= 10) break;
        const id = el.getAttribute('data-review-id');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const ratingEl = el.querySelector('[role="img"][aria-label*="star"]');
        const rating = ratingEl ? ratingEl.getAttribute('aria-label') : null;
        const hinted = el.querySelector('.MyEned, .wiI7pd, .rvItrb');
        const text = hinted
          ? stripMore(hinted.innerText)
          : stripMore(
              Array.from(el.querySelectorAll('span, div'))
                .map((n) => (n.innerText || '').trim())
                .sort((a, b) => b.length - a.length)[0] || ''
            );
        if (text) out.push({ text, rating });
      }
      return out;
    })
    .catch(() => []);
}

async function extractDetail(page, placeUrl, delay) {
  // Force English UI regardless of the browser/account locale
  const navUrl = placeUrl.includes('?') ? `${placeUrl}&hl=en` : `${placeUrl}?hl=en`;
  await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('h1', { timeout: 15000 });
  await sleep(1500);

  const data = {
    title: await firstText(page, ['h1.DUwDvf', 'h1']),
    url: placeUrl,
    category: await firstText(page, [
      'button[jsaction*="category"]',
      'button[class*="DkEaL"]',
    ]),
    address: await firstText(page, [
      'button[data-item-id="address"]',
      'button[data-item-id*="address"]',
      'div[data-item-id="address"]',
    ]),
    website: await firstAttr(page, ['a[data-item-id="authority"]'], 'href'),
    phone: await firstText(page, [
      'button[data-item-id^="phone"]',
      'div[data-item-id^="phone"]',
    ]),
    plusCode: await firstText(page, [
      'button[data-item-id="oloc"]',
      'div[data-item-id="oloc"]',
    ]),
    bookingLink: await firstAttr(page, ['a[data-item-id*="booking"]'], 'href'),
  };

  Object.assign(data, await extractRating(page));

  // The place page always carries the listing's position in its URL, which
  // gives us coordinates for free (used for the area/radius filter).
  const coords = parsePlaceCoords(page.url());
  if (coords) {
    data.lat = coords.lat;
    data.lng = coords.lng;
  }

  data.socials = await page
    .$$eval(
      'a[data-item-id*="social"], a[href*="instagram.com"], a[href*="facebook.com"], a[href*="linkedin.com"]',
      (els) => els.map((e) => e.href).filter(Boolean)
    )
    .catch(() => []);

  // Hours first: opening hours swaps the panel to a sub-view, but extractHours
  // clicks Back to restore the overview. Then reviews (inline + Reviews tab).
  data.hours = await extractHours(page);
  data.reviews = await collectReviews(page);
  data.scrapedAt = new Date().toISOString();

  await delay();
  return data;
}

async function extractDetailWithRetry(page, placeUrl, delay, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await extractDetail(page, placeUrl, delay);
    } catch (e) {
      lastErr = e;
      warn(`detail attempt ${attempt + 1} failed for ${placeUrl}: ${e.message}`);
      await sleep(1500);
    }
  }
  throw lastErr;
}

module.exports = { extractDetailWithRetry, extractRating, extractReviews, collectReviews };
