#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs } = require('util');
const { log } = require('./lib/utils');
const { runScrapeJob } = require('./lib/runner');

function usage() {
  console.log(`Usage:
  node scraper.js "<search query>" [maxResults] [options]
  node scraper.js --industry "web development agencies" --place "Nairobi" [maxResults]

Options:
  --industry <text>   Industry / business type (with --place builds "<industry> in <place>")
  --place <text>      Location to search
  --max <n>           Max results (or pass as 2nd positional)
  --all               No result cap: scroll every search unit until Google reports
                      the end of the list
  --area <text>       Small-area mode: street, road, district or neighbourhood
  --radius <km>       Radius of the small area (default 3)
  --tile-km <km>      Tile size of the area grid (default 2)
  --lat <n>           Area centre latitude (overrides the lookup)
  --lng <n>           Area centre longitude (overrides the lookup)
  --sub-areas         Also scan the sub-areas Google lists for the area
  --keep-outside      Keep listings that fall outside the area/radius
  --headless          Run browser headless (default: headed, friendlier to Google)
  --no-contact        Skip email/social discovery on business websites
  --proxy <url>       Single proxy, e.g. http://user:pass@host:port
  --proxy-file <f>    Proxy list (one URL per line), rotated every 25 listings
  --out <dir>         Output directory (default: ./output)
  --delay <min[:max]> Human delay in ms between actions (default 800:2400)
  --resume <jsonl>    Resume a previous run, skipping already-scraped URLs
  --help              Show this help

Examples:
  node scraper.js "web development agencies in Nairobi" 30
  node scraper.js --industry "coffee shops" --place "Nairobi" --max 20
  node scraper.js --industry "dentists" --area "Ngong Road, Nairobi" --radius 3 --all
  node scraper.js "dentists in London" 50 --proxy-file proxies.txt
`);
}

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      industry: { type: 'string' },
      place: { type: 'string' },
      max: { type: 'string' },
      all: { type: 'boolean', default: false },
      area: { type: 'string' },
      radius: { type: 'string' },
      'tile-km': { type: 'string' },
      lat: { type: 'string' },
      lng: { type: 'string' },
      'sub-areas': { type: 'boolean', default: false },
      'keep-outside': { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      'no-contact': { type: 'boolean', default: false },
      proxy: { type: 'string' },
      'proxy-file': { type: 'string' },
      out: { type: 'string', default: path.join(__dirname, 'output') },
      delay: { type: 'string' },
      resume: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const query = positionals[0] || '';
  const max = parseInt(values.max || positionals[1] || '20', 10);
  const areaText = (values.area || '').trim();
  const hasArea = !!areaText || values.lat !== undefined || values.lng !== undefined;

  return {
    help: values.help,
    opts: {
      query,
      industry: values.industry,
      place: values.place,
      max,
      allResults: values.all,
      area: hasArea
        ? {
            enabled: true,
            place: areaText,
            radiusKm: values.radius !== undefined ? parseFloat(values.radius) : 3,
            tileKm: values['tile-km'] !== undefined ? parseFloat(values['tile-km']) : 2,
            lat: values.lat !== undefined ? parseFloat(values.lat) : null,
            lng: values.lng !== undefined ? parseFloat(values.lng) : null,
            subAreas: values['sub-areas'],
            keepOutside: values['keep-outside'],
          }
        : null,
      headless: values.headless,
      contact: !values['no-contact'],
      proxy: values.proxy,
      proxyFile: values['proxy-file'],
      outDir: values.out,
      delayStr: values.delay,
      resume: values.resume,
    },
  };
}

async function main() {
  const { help, opts } = parseCli(process.argv.slice(2));
  if (help || (!opts.query && !opts.industry && !opts.place && !opts.area)) {
    usage();
    process.exit(help ? 0 : 1);
  }

  const job = runScrapeJob(opts);
  const controller = await job.promise;
  log(`Job ${controller.state}: ${controller.records.length} records.`);
  process.exit(controller.state === 'error' ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
