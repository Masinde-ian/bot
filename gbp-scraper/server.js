'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const bus = require('./lib/events');
const { log, warn } = require('./lib/utils');
const { runScrapeJob, getActiveJob } = require('./lib/runner');
const { listRuns, readRun, resolveRunFile } = require('./lib/output');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '127.0.0.1';
const OUT_DIR = path.join(__dirname, 'output');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// Keep the last few job controllers in memory so the UI can reconnect/summarize.
const jobs = new Map();
const JOB_HISTORY = 20;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function streamRunFile(res, base, ext, downloadName) {
  let filePath;
  try {
    filePath = resolveRunFile(OUT_DIR, base, ext);
  } catch (e) {
    return sendJson(res, 404, { error: e.message });
  }
  const type = ext === '.csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${downloadName || base + ext}"`,
  });
  fs.createReadStream(filePath).pipe(res);
}

function handleEvents(req, res, jobId) {
  const controller = jobs.get(jobId);
  if (!controller) return sendJson(res, 404, { error: 'Unknown job' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  // Replay buffered events for late subscribers
  for (const e of controller.events) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  const onEvent = (e) => {
    if (e.jobId !== jobId) return;
    try {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  bus.on('job', onEvent);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    bus.removeListener('job', onEvent);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  // If the job already finished, close once the replay is flushed
  if (['done', 'error', 'stopped'].includes(controller.state)) {
    setTimeout(() => {
      cleanup();
      res.end();
    }, 200);
  }
}

function startJob(payload) {
  if (getActiveJob()) {
    const err = new Error('A scrape job is already running');
    err.statusCode = 409;
    throw err;
  }
  const rawArea = payload.area && payload.area.enabled ? payload.area : null;
  const opts = {
    query: payload.query,
    industry: payload.industry,
    place: payload.place,
    max: payload.max,
    allResults: !!payload.allResults,
    headless: !!payload.headless,
    contact: payload.contact !== false,
    proxy: payload.proxy || undefined,
    proxyFile: payload.proxyFile || undefined,
    outDir: OUT_DIR,
    delayStr: payload.delay || undefined,
    continueBase: payload.continueBase || undefined,
    area: rawArea
      ? {
          enabled: true,
          place: String(rawArea.place || '').trim(),
          radiusKm: rawArea.radiusKm,
          tileKm: rawArea.tileKm,
          lat: rawArea.lat,
          lng: rawArea.lng,
          subAreas: !!rawArea.subAreas,
          keepOutside: !!rawArea.keepOutside,
        }
      : undefined,
  };
  const controller = runScrapeJob(opts);
  jobs.set(controller.id, controller);
  if (jobs.size > JOB_HISTORY) {
    const oldest = jobs.keys().next().value;
    jobs.delete(oldest);
  }
  controller.promise.catch((e) => warn(`job ${controller.id} crashed: ${e.message}`));
  return controller;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}`);
  } catch {
    return sendJson(res, 400, { error: 'Bad URL' });
  }
  const { pathname } = url;
  const method = req.method;

  try {
    if (pathname === '/api/jobs' && method === 'POST') {
      const body = await readBody(req);
      try {
        const controller = startJob(body);
        return sendJson(res, 202, {
          jobId: controller.id,
          query: controller.query,
          max: controller.max,
          allResults: !!controller.allResults,
          area: controller.area || null,
          base: controller.base || null,
          continue: !!body.continueBase,
        });
      } catch (e) {
        return sendJson(res, e.statusCode || 400, { error: e.message });
      }
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(\/events|\/stop)?$/);
    if (jobMatch) {
      const [, jobId, action] = jobMatch;
      const controller = jobs.get(jobId);
      if (!controller) return sendJson(res, 404, { error: 'Unknown job' });

      if (action === '/events' && method === 'GET') {
        return handleEvents(req, res, jobId);
      }
      if (action === '/stop' && method === 'POST') {
        controller.stop();
        return sendJson(res, 200, { ok: true, state: controller.state });
      }
      if (!action && method === 'GET') {
        return sendJson(res, 200, {
          id: controller.id,
          query: controller.query,
          state: controller.state,
          done: controller.records.length,
          total: controller.total,
          base: controller.base || null,
          records: controller.records,
        });
      }
    }

    if (pathname === '/api/runs' && method === 'GET') {
      return sendJson(res, 200, { runs: listRuns(OUT_DIR) });
    }

    const runMatch = pathname.match(/^\/api\/runs\/(.+?)(?:\.(csv|json))?$/);
    if (runMatch && method === 'GET') {
      const base = decodeURIComponent(runMatch[1]);
      const ext = runMatch[2];
      if (ext === 'csv' || ext === 'json') {
        return streamRunFile(res, base, `.${ext}`, `gbp_${base}.${ext}`);
      }
      // /api/runs/:base -> records
      try {
        const records = readRun(OUT_DIR, base);
        return sendJson(res, 200, { base, records });
      } catch (e) {
        return sendJson(res, 404, { error: e.message });
      }
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    return serveStatic(req, res, pathname);
  } catch (e) {
    warn(`request error: ${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  log(`GBP scraper UI running at ${url}`);
  if (!process.env.NO_OPEN) {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      /* opening the browser is best-effort */
    }
  }
});

module.exports = { server };
