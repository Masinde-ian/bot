'use strict';

const fs = require('fs');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { log, warn } = require('./utils');

chromium.use(stealth);

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function parseProxyUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid proxy URL: ${raw}`);
  }
  const server = `${url.protocol}//${url.host}`;
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  return { server, username, password, raw };
}

function loadProxies({ proxy, proxyFile }) {
  const list = [];
  if (proxy) list.push(parseProxyUrl(proxy));
  if (proxyFile) {
    const lines = fs
      .readFileSync(proxyFile, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    for (const l of lines) list.push(parseProxyUrl(l));
  }
  if (!list.length && process.env.PROXY_URL) {
    list.push(parseProxyUrl(process.env.PROXY_URL));
  }
  return list;
}

class ProxyPool {
  constructor(proxies) {
    this.proxies = proxies;
    this.index = 0;
  }

  get enabled() {
    return this.proxies.length > 0;
  }

  current() {
    if (!this.proxies.length) return null;
    return this.proxies[this.index % this.proxies.length];
  }

  rotate() {
    if (!this.proxies.length) return null;
    this.index = (this.index + 1) % this.proxies.length;
    log(`Proxy rotated -> ${this.current().raw}`);
    return this.current();
  }

  label() {
    const p = this.current();
    return p ? p.raw : 'direct';
  }
}

async function launchBrowser({ headless, proxy, extraArgs = [] }) {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    ...extraArgs,
  ];
  const launchOpts = { headless, args };
  if (proxy) {
    launchOpts.proxy = {
      server: proxy.server,
      ...(proxy.username ? { username: proxy.username } : {}),
      ...(proxy.password ? { password: proxy.password } : {}),
    };
  }
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'Europe/London',
    userAgent: DEFAULT_UA,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  return { browser, context, page };
}

// Handles both the button-based and full-page consent variants Google serves.
async function handleConsent(page) {
  try {
    const button = page.locator(
      'button:has-text("Accept all"), button:has-text("I agree"), ' +
        'button:has-text("Reject all"), button[aria-label="Accept all"]'
    );
    if (await button.first().isVisible({ timeout: 4000 })) {
      const label = (await button.first().textContent()) || '';
      await button.first().click();
      log(`Consent screen handled: "${label.trim()}"`);
      await page.waitForTimeout(1500);
      return true;
    }
  } catch {
    // no consent screen
  }
  return false;
}

// Returns true if the page looks like a bot-check / unusual traffic wall.
async function isBlocked(page) {
  try {
    const body = (await page.textContent('body', { timeout: 3000 })) || '';
    return /unusual traffic|our systems have detected|detected unusual traffic|not a robot/i.test(
      body
    );
  } catch {
    return false;
  }
}

module.exports = {
  launchBrowser,
  handleConsent,
  isBlocked,
  loadProxies,
  ProxyPool,
};
