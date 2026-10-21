'use strict';

const { sleep, warn } = require('./utils');

const SOCIAL_HOSTS = {
  'facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'linkedin.com': 'linkedin',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'tiktok.com': 'tiktok',
  'youtube.com': 'youtube',
  'wa.me': 'whatsapp',
  'api.whatsapp.com': 'whatsapp',
};

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SKIP_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ico)$/i;

function normalizeEmails(text) {
  if (!text) return [];
  const matches = text.match(EMAIL_RE) || [];
  const seen = new Set();
  const out = [];
  for (let m of matches) {
    m = m.replace(/[.,;:]+$/, '');
    if (SKIP_EMAIL.test(m)) continue;
    const key = m.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

function socialFromUrl(href) {
  try {
    const host = new URL(href).hostname.replace(/^www\./, '');
    for (const [needle, name] of Object.entries(SOCIAL_HOSTS)) {
      if (host === needle || host.endsWith('.' + needle)) return name;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

// Harvest contacts directly from a page's DOM (no extra navigation).
function harvestFromPage(page) {
  return page.evaluate(
    ({ emailRe, socialMap }) => {
      const emails = [];
      const socials = {};
      const re = new RegExp(emailRe.source, emailRe.flags);

      document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
        const raw = a.getAttribute('href').slice(7).split('?')[0];
        if (raw) emails.push(raw);
      });
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.href || '';
        if (href.startsWith('mailto:')) {
          emails.push(href.slice(7).split('?')[0]);
        }
        let host;
        try {
          host = new URL(href).hostname.replace(/^www\./, '');
        } catch {
          return;
        }
        for (const needle of Object.keys(socialMap)) {
          if (host === needle || host.endsWith('.' + needle)) {
            const name = socialMap[needle];
            if (!socials[name]) socials[name] = href.split('#')[0];
          }
        }
      });

      // Visible text + JSON-LD emails
      const text = document.body.innerText || '';
      (text.match(re) || []).forEach((e) => emails.push(e));
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        const t = s.textContent || '';
        (t.match(re) || []).forEach((e) => emails.push(e));
      });

      return { emails, socials };
    },
    { emailRe: EMAIL_RE, socialMap: SOCIAL_HOSTS }
  );
}

async function discoverContacts(page, record, { maxPages = 3, timeout = 15000 } = {}) {
  const found = { email: [], socials: {} };

  // 1) Social links already on the GBP profile
  for (const href of record.socials || []) {
    const name = socialFromUrl(href);
    if (name && !found.socials[name]) found.socials[name] = href.split('#')[0];
  }

  const website = record.website;
  if (!website) return finalize(found);

  const candidates = [website];
  try {
    const u = new URL(website, 'https://example.com');
    const origin = `${u.protocol}//${u.host}`;
    candidates.push(`${origin}/contact`, `${origin}/about`);
  } catch {
    /* keep as-is */
  }

  for (const url of candidates.slice(0, maxPages)) {
    if (found.email.length && Object.keys(found.socials).length >= 3) break;
    try {
      const resp = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      if (!resp || resp.status() >= 400) continue;
      await sleep(600);
      const res = await harvestFromPage(page);
      res.emails.forEach((e) => {
        if (!found.email.includes(e)) found.email.push(e);
      });
      Object.assign(found.socials, res.socials);
    } catch (e) {
      warn(`contact crawl failed for ${url}: ${e.message}`);
    }
  }

  return finalize(found);
}

function finalize(found) {
  return {
    email: found.email.slice(0, 5),
    socials: found.socials,
    facebook: found.socials.facebook || null,
    instagram: found.socials.instagram || null,
    linkedin: found.socials.linkedin || null,
    twitter: found.socials.twitter || null,
    youtube: found.socials.youtube || null,
    tiktok: found.socials.tiktok || null,
    whatsapp: found.socials.whatsapp || null,
  };
}

module.exports = { discoverContacts, normalizeEmails, socialFromUrl };
