'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  records: [],
  base: null,
  jobId: null,
  running: false,
  total: 0,
  sessionTotal: 0,
  sessionDone: 0,
  continueBase: null,
  es: null,
  sortKey: 'rating',
  sortDir: 'desc',
  viewing: 'live',
  allResults: false,
  areaMode: false,
};

const LAST_SEARCH_KEY = 'gbp:lastSearch';

const EXPORT_COLUMNS = [
  'title', 'category', 'address', 'phone', 'website', 'email',
  'facebook', 'instagram', 'linkedin', 'twitter', 'youtube', 'tiktok', 'whatsapp',
  'plusCode', 'rating', 'reviewsCount', 'hours', 'reviews', 'url', 'scrapedAt',
  'lat', 'lng', 'distanceKm', 'area', 'areaMatch',
];

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function socialsOf(r) {
  return ['facebook', 'instagram', 'linkedin', 'twitter', 'youtube', 'tiktok', 'whatsapp']
    .map((k) => (r[k] ? { key: k, url: r[k] } : null))
    .filter(Boolean);
}

function emailsOf(r) {
  if (Array.isArray(r.email)) return r.email;
  if (typeof r.email === 'string' && r.email) return [r.email];
  if (r.contact && Array.isArray(r.contact.email)) return r.contact.email;
  return [];
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = `pill pill-${kind}`;
}

function logLine(text, level = 'info') {
  const log = $('log');
  const time = new Date().toLocaleTimeString();
  log.textContent += `[${time}] ${level === 'warn' ? 'WARN: ' : ''}${text}\n`;
  log.scrollTop = log.scrollHeight;
}

function setProgress(done, total) {
  $('progress-count').textContent = `${done} / ${total || state.total || 0}`;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  $('bar-fill').style.width = pct + '%';
}

function setRunning(running) {
  state.running = running;
  $('start').disabled = running;
  $('stop').disabled = !running;
}

// ---------- Query preview ----------
function areaOptions() {
  return {
    enabled: $('area-mode').checked,
    place: $('area').value.trim(),
    radiusKm: parseFloat($('radius').value) || 3,
    tileKm: parseFloat($('tileKm').value) || 2,
    subAreas: $('sub-areas').checked,
    keepOutside: $('keep-outside').checked,
  };
}

function tileCount(radiusKm, tileKm) {
  const step = tileKm / 111.32;
  const rows = Math.max(1, Math.ceil((radiusKm * 2) / 111.32 / step));
  return rows * rows;
}

function updateAreaHint() {
  const a = areaOptions();
  const el = $('area-hint');
  const sum = $('area-summary');
  if (!a.enabled) {
    el.textContent = ' ';
    if (sum) sum.textContent = '';
    return;
  }
  if (!a.place) {
    el.textContent = 'Enter the area name (street, road, district).';
    if (sum) sum.textContent = '';
    return;
  }
  const tiles = tileCount(a.radiusKm, a.tileKm);
  el.textContent =
    `${tiles} grid tiles + "in/near" variants + sub-areas = broad coverage of ${a.place}. ` +
    'Results are filtered to within radius of the area; addresses with the area name are kept.';
  if (sum) sum.textContent = `Small area: ${a.place} (radius ${a.radiusKm} km)`;
}

function updateQueryPreview() {
  const i = $('industry').value.trim();
  const p = $('place').value.trim();
  const a = areaOptions();
  let q = '—';
  if (a.enabled && a.place) q = i ? `${i} in ${a.place}` : a.place;
  else if (i && p) q = `${i} in ${p}`;
  else if (i || p) q = i || p;
  $('query-preview').textContent = q;
  updateAreaHint();
}
['industry', 'place', 'area', 'radius', 'tileKm'].forEach((id) =>
  $(id).addEventListener('input', updateQueryPreview)
);
['area-mode', 'sub-areas'].forEach((id) =>
  $(id).addEventListener('change', updateQueryPreview)
);

// ---------- All-results toggle ----------
function setAllResults(on) {
  state.allResults = !!on;
  const btn = $('all-toggle');
  btn.setAttribute('aria-pressed', String(state.allResults));
  btn.textContent = state.allResults ? 'All results' : 'Max only';
  btn.classList.toggle('on', state.allResults);
  $('max').disabled = state.allResults;
  $('max').placeholder = state.allResults ? '∞' : '';
  $('all-hint').textContent = state.allResults
    ? 'No cap: every search unit is scrolled until Google reports the end of the list. Use small-area mode to get past the ~120-result cap of a single search.'
    : 'Stops at the max above. One Google search never returns more than ~120 results.';
}

$('all-toggle').addEventListener('click', () => setAllResults(!state.allResults));

$('area-mode').addEventListener('change', () => {
  state.areaMode = $('area-mode').checked;
  $('area-fields').classList.toggle('hidden', !state.areaMode);
  updateQueryPreview();
});

// ---------- Filtering / sorting / rendering ----------
function passFilters(r) {
  const text = $('filter-text').value.trim().toLowerCase();
  if (text) {
    const hay = [
      r.title, r.category, r.address, ...emailsOf(r), r.phone, r.website,
    ].join(' ').toLowerCase();
    if (!hay.includes(text)) return false;
  }
  const minRating = parseFloat($('filter-rating').value) || 0;
  if (minRating && !(Number(r.rating) >= minRating)) return false;
  if ($('filter-email').checked && !emailsOf(r).length) return false;
  if ($('filter-website').checked && !r.website) return false;
  if ($('filter-nowebsite').checked && r.website) return false;
  return true;
}

function filteredRecords() {
  return sortRecords(state.records.filter(passFilters));
}

function sortRecords(list) {
  const key = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (key === 'reviewsCount' || key === 'rating') {
      av = Number(av) || 0;
      bv = Number(bv) || 0;
    } else {
      av = String(av || '').toLowerCase();
      bv = String(bv || '').toLowerCase();
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function renderResults() {
  const body = $('results-body');
  const filtered = sortRecords(state.records.filter(passFilters));
  $('results-count').textContent = state.records.length
    ? `(${filtered.length} of ${state.records.length})`
    : '';

  const noWebsite = state.records.filter((r) => !r.website).length;
  $('nowebsite-count').textContent = noWebsite;
  updateExportButtons();

  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="9" class="muted center">${
      state.records.length ? 'No rows match the filters.' : 'No results yet — run a search.'
    }</td></tr>`;
    return;
  }

  body.innerHTML = filtered
    .map((r, idx) => {
      const emails = emailsOf(r);
      const socials = socialsOf(r);
      const rating = r.rating != null ? `★ ${Number(r.rating).toFixed(1)}` : '—';
      const km = r.distanceKm != null ? Number(r.distanceKm).toFixed(2) : '';
      return `<tr data-idx="${state.records.indexOf(r)}" title="Click for details">
        <td class="name">${escapeHtml(r.title || '(no title)')}</td>
        <td>${escapeHtml(r.category || '')}</td>
        <td class="num">${rating}</td>
        <td class="num">${r.reviewsCount != null ? escapeHtml(r.reviewsCount) : ''}</td>
        <td>${escapeHtml(r.phone || '')}</td>
        <td>${emails.length ? `<a href="mailto:${escapeHtml(emails[0])}" onclick="event.stopPropagation()">${escapeHtml(emails[0])}</a>` : ''}${
          emails.length > 1 ? ` <span class="muted">+${emails.length - 1}</span>` : ''
        }</td>
        <td class="socials">${socials
          .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${s.key}" onclick="event.stopPropagation()">${s.key[0].toUpperCase()}</a>`)
          .join(' ')}</td>
        <td>${escapeHtml(r.address || '')}</td>
        <td class="num">${km}</td>
      </tr>`;
    })
    .join('');
}

$('results-body').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-idx]');
  if (!tr) return;
  openDrawer(state.records[Number(tr.dataset.idx)]);
});

document.querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = key === 'rating' || state.sortKey === 'reviewsCount' ? 'desc' : 'asc';
    }
    renderResults();
  });
});

['filter-text', 'filter-rating', 'filter-email', 'filter-website', 'filter-nowebsite'].forEach(
  (id) => $(id).addEventListener('input', renderResults)
);

$('filter-website').addEventListener('change', () => {
  if ($('filter-website').checked) $('filter-nowebsite').checked = false;
  renderResults();
});
$('filter-nowebsite').addEventListener('change', () => {
  if ($('filter-nowebsite').checked) $('filter-website').checked = false;
  renderResults();
});

// ---------- Drawer ----------
function openDrawer(r) {
  if (!r) return;
  const emails = emailsOf(r);
  const socials = socialsOf(r);
  const hours = Array.isArray(r.hours)
    ? `<table class="hours">${r.hours
        .map((h) => `<tr><td>${escapeHtml(h.day)}</td><td>${escapeHtml(h.hours)}</td></tr>`)
        .join('')}</table>`
    : '<p class="muted">No hours.</p>';
  const reviews = Array.isArray(r.reviews) && r.reviews.length
    ? r.reviews
        .map(
          (rv) => `<div class="review"><div class="review-rating">${escapeHtml(rv.rating || '')}</div><p>${escapeHtml(rv.text || '')}</p></div>`
        )
        .join('')
    : '<p class="muted">No reviews captured.</p>';

  $('drawer-body').innerHTML = `
    <h3>${escapeHtml(r.title || '(no title)')}</h3>
    <p class="muted">${escapeHtml(r.category || '')}${r.rating != null ? ` · ★ ${Number(r.rating).toFixed(1)} (${r.reviewsCount || 0} reviews)` : ''}</p>
    <dl class="detail-grid">
      ${r.phone ? `<dt>Phone</dt><dd>${escapeHtml(r.phone)}</dd>` : ''}
      ${r.website ? `<dt>Website</dt><dd><a href="${escapeHtml(r.website)}" target="_blank" rel="noopener">${escapeHtml(r.website)}</a></dd>` : ''}
      ${emailsOf(r).length ? `<dt>Email</dt><dd>${emailsOf(r).map((e) => `<a href="mailto:${escapeHtml(e)}">${escapeHtml(e)}</a>`).join(', ')}</dd>` : ''}
      ${socialsOf(r).length ? `<dt>Socials</dt><dd>${socialsOf(r).map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.key)}</a>`).join(', ')}</dd>` : ''}
      ${r.address ? `<dt>Address</dt><dd>${escapeHtml(r.address)}</dd>` : ''}
      ${r.plusCode ? `<dt>Plus code</dt><dd>${escapeHtml(r.plusCode)}</dd>` : ''}
      ${r.url ? `<dt>Google Maps</dt><dd><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Open listing</a></dd>` : ''}
    </dl>
    <h4>Hours</h4>
    ${hours}
    <h4>Reviews</h4>
    ${reviews}
  `;
  $('drawer').classList.remove('hidden');
}

$('drawer-close').addEventListener('click', () => $('drawer').classList.add('hidden'));
$('drawer').addEventListener('click', (e) => {
  if (e.target.id === 'drawer') $('drawer').classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('drawer').classList.add('hidden');
});

// ---------- Exports ----------
function visibleRecords() {
  return sortRecords(state.records.filter(passFilters));
}

function updateExportButtons() {
  const hasRun = !!state.base && state.records.length > 0;
  $('export-csv').disabled = !hasRun;
  $('export-json').disabled = !hasRun;
  const enabled = state.records.length > 0;
  $('export-filtered').disabled = !enabled;
  $('copy-emails').disabled = !enabled;
}

function csvCell(v) {
  const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function flattenForCsv(rec) {
  const out = {};
  for (const col of EXPORT_COLUMNS) {
    let v = rec[col];
    if (col === 'email') v = emailsOf(rec);
    if (col === 'hours') {
      v = Array.isArray(rec.hours)
        ? rec.hours.map((h) => `${h.day}: ${h.hours}`).join(' | ')
        : '';
    }
    if (col === 'reviews') {
      v = Array.isArray(rec.reviews)
        ? rec.reviews.map((r) => (r.rating ? `[${r.rating}] ${r.text}` : r.text)).join(' ~ ')
        : '';
    }
    out[col] = v;
  }
  return out;
}

function downloadFilteredCsv() {
  const rows = visibleRecords();
  if (!rows.length) return;
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const rec of rows) {
    const flat = flattenForCsv(rec);
    lines.push(EXPORT_COLUMNS.map((c) => csvCell(flat[c])).join(','));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const name = `${state.base || 'leads'}_filtered`;
  a.href = url;
  a.download = `${name}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyEmails() {
  const emails = [...new Set(visibleRecords().flatMap((r) => emailsOf(r)))];
  const btn = $('copy-emails');
  if (!emails.length) {
    btn.textContent = 'No emails';
    setTimeout(() => (btn.textContent = 'Copy emails'), 1500);
    return;
  }
  const text = emails.join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.textContent = `Copied ${emails.length}`;
  setTimeout(() => (btn.textContent = 'Copy emails'), 1500);
}

$('export-csv').addEventListener('click', () => {
  if (state.base) window.location.href = `/api/runs/${encodeURIComponent(state.base)}.csv`;
});
$('export-json').addEventListener('click', () => {
  if (state.base) window.location.href = `/api/runs/${encodeURIComponent(state.base)}.json`;
});
$('export-filtered').addEventListener('click', downloadFilteredCsv);
$('copy-emails').addEventListener('click', copyEmails);

// ---------- Job control ----------
function resetForJob({ keepRecords = false } = {}) {
  if (!keepRecords) {
    state.records = [];
    state.base = null;
  }
  state.total = 0;
  state.sessionTotal = 0;
  state.sessionDone = 0;
  state.jobId = null;
  state.continueBase = null;
  state.viewing = 'live';
  $('log').textContent = '';
  $('current-listing').textContent = 'Starting…';
  renderResults();
  setProgress(0, 0);
}

function saveLastSearch() {
  try {
    localStorage.setItem(
      LAST_SEARCH_KEY,
      JSON.stringify({
        industry: $('industry').value,
        place: $('place').value,
        max: $('max').value,
        contact: $('contact').checked,
        headless: $('headless').checked,
        allResults: state.allResults,
        areaMode: state.areaMode,
        area: $('area').value,
        radius: $('radius').value,
        tileKm: $('tileKm').value,
        subAreas: $('sub-areas').checked,
        keepOutside: $('keep-outside').checked,
      })
    );
  } catch {
    /* ignore */
  }
}

async function startJob(e) {
  e.preventDefault();
  $('form-error').classList.add('hidden');
  const industry = $('industry').value.trim();
  const place = $('place').value.trim();
  const area = areaOptions();
  const continueBase = state.continueBase;
  if (!continueBase && !industry && !place && !area.place) {
    showError('Enter an industry and/or a place.');
    return;
  }
  const payload = {
    industry,
    place,
    max: parseInt($('max').value, 10) || 20,
    allResults: state.allResults,
    contact: $('contact').checked,
    headless: $('headless').checked,
    proxy: $('proxy').value.trim() || undefined,
    proxyFile: $('proxyFile').value.trim() || undefined,
    delay: $('delay').value.trim() || undefined,
    continueBase: continueBase || undefined,
    area: area.enabled ? area : undefined,
  };

  resetForJob({ keepRecords: !!continueBase });
  if (continueBase) {
    setStatus('Continuing…', 'running');
    $('progress-title').textContent = `Continuing: ${industry || place || continueBase}`;
  } else if (area.enabled && area.place) {
    setStatus('Starting…', 'running');
    $('progress-title').textContent = `Scraping: ${industry || '(everything)'} · ${area.place}`;
  } else {
    setStatus('Starting…', 'running');
    $('progress-title').textContent = `Scraping: ${industry || place}${place && industry ? ` · ${place}` : ''}`;
  }
  saveLastSearch();
  setRunning(true);

  try {
    const resp = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to start');
    state.jobId = data.jobId;
    subscribe(data.jobId);
    loadRuns();
  } catch (err) {
    showError(err.message);
    setRunning(false);
    setStatus('Error', 'error');
  } finally {
    state.continueBase = null;
  }
}

function showError(msg) {
  const el = $('form-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function subscribe(jobId) {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  state.es = es;

  es.onmessage = (ev) => {
    let e;
    try {
      e = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(e);
  };
  es.onerror = () => {
    // Browser auto-reconnects; if the job is over the server closes the stream.
  };
}

function handleEvent(e) {
  switch (e.type) {
    case 'log':
      logLine(e.message, e.level);
      break;
    case 'stage':
      if (e.message) logLine(e.message);
      if (e.stage === 'searching' && e.base) state.base = e.base;
      if (e.stage === 'searching') setStatus('Searching…', 'running');
      if (e.stage === 'stopping') setStatus('Stopping…', 'stopping');
      break;
    case 'found': {
      state.total = e.total;
      state.sessionTotal = e.total;
      state.sessionDone = 0;
      setProgress(0, e.total);
      const parts = [`Found ${e.total} new listing${e.total === 1 ? '' : 's'}`];
      if (e.units) parts.push(`${e.units} search${e.units === 1 ? '' : 'es'}`);
      if (e.skipped) parts.push(`${e.skipped} already scraped`);
      if (e.outsideArea) parts.push(`${e.outsideArea} outside the area`);
      $('current-listing').textContent = `${parts.join(' · ')}. Scraping details…`;
      logLine(`${parts.join(' · ')}.`);
      break;
    }
    case 'skip':
      logLine(`Skipped (already scraped): ${e.url}`, 'warn');
      break;
    case 'record': {
      state.records.push(e.record);
      state.sessionDone++;
      renderResults();
      setProgress(state.sessionDone, state.sessionTotal);
      $('current-listing').textContent = `[${e.index}/${e.total}] ${e.record.title || '(no title)'}`;
      break;
    }
    case 'error':
      logLine(e.message, 'warn');
      break;
    case 'done':
      setProgress(e.count, e.count);
      setRunning(false);
      setStatus(e.status === 'stopped' ? 'Stopped' : e.status === 'error' ? 'Error' : 'Done',
        e.status === 'error' ? 'error' : e.status === 'stopped' ? 'idle' : 'done');
      if (e.base) state.base = e.base;
      logLine(`Finished (${e.status}): ${e.count} records.`);
      if (e.base) {
        $('export-csv').disabled = false;
        $('export-json').disabled = false;
      }
      if (state.es) {
        state.es.close();
        state.es = null;
      }
      loadRuns();
      break;
    default:
      break;
  }
}

async function stopJob() {
  if (!state.jobId) return;
  setStatus('Stopping…', 'running');
  try {
    await fetch(`/api/jobs/${state.jobId}/stop`, { method: 'POST' });
  } catch {
    /* ignore */
  }
}

$('search-form').addEventListener('submit', startJob);
$('stop').addEventListener('click', stopJob);

// ---------- Past runs ----------
async function loadRuns() {
  try {
    const resp = await fetch('/api/runs');
    const data = await resp.json();
    const list = $('runs-list');
    if (!data.runs || !data.runs.length) {
      list.innerHTML = '<li class="muted">No runs yet.</li>';
      return;
    }
    list.innerHTML = data.runs
      .map((r) => {
        const label = r.query || r.industry || r.base;
        const when = (r.updatedAt || r.startedAt)
          ? new Date(r.updatedAt || r.startedAt).toLocaleString()
          : '';
        const sessions = r.sessions && r.sessions > 1 ? ` · ${r.sessions} sessions` : '';
        return `<li class="run-item">
          <button type="button" class="run-btn" data-base="${escapeHtml(r.base)}"
            data-industry="${escapeHtml(r.industry || '')}"
            data-place="${escapeHtml(r.place || '')}"
            data-query="${escapeHtml(r.query || '')}">
            <span class="run-title">${escapeHtml(label)}</span>
            <span class="run-meta">${r.count} rows${sessions} · ${escapeHtml(when)}</span>
          </button>
          <button type="button" class="btn ghost small run-continue" data-base="${escapeHtml(r.base)}"
            title="Find more businesses for this search">Continue</button>
        </li>`;
      })
      .join('');
  } catch {
    $('runs-list').innerHTML = '<li class="muted">Failed to load runs.</li>';
  }
}

async function loadRun(base) {
  try {
    const resp = await fetch(`/api/runs/${encodeURIComponent(base)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load run');
    state.records = data.records || [];
    state.base = base;
    state.viewing = 'history';
    $('progress-title').textContent = `History: ${base}`;
    $('current-listing').textContent = `${state.records.length} records loaded.`;
    setProgress(state.records.length, state.records.length);
    setStatus('History', 'idle');
    setRunning(false);
    renderResults();
    $('export-csv').disabled = !state.records.length;
    $('export-json').disabled = !state.records.length;
  } catch (e) {
    alert(e.message);
  }
}

async function continueRun(li, base) {
  if (state.running) return;
  const runBtn = li ? li.querySelector('.run-btn') : null;
  const industry = runBtn ? runBtn.dataset.industry : '';
  const place = runBtn ? runBtn.dataset.place : '';
  try {
    const resp = await fetch(`/api/runs/${encodeURIComponent(base)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load run');
    state.records = data.records || [];
    state.base = base;
    state.continueBase = base;
    if (industry) $('industry').value = industry;
    if (place) $('place').value = place;
    updateQueryPreview();
    renderResults();
    $('progress-title').textContent = `Continuing: ${industry || place || base}`;
    $('current-listing').textContent = `${state.records.length} already scraped — searching deeper…`;
    $('search-form').requestSubmit();
  } catch (err) {
    alert(err.message);
  }
}

$('runs-list').addEventListener('click', (e) => {
  const cont = e.target.closest('.run-continue');
  if (cont) {
    continueRun(cont.closest('.run-item'), cont.dataset.base);
    return;
  }
  const btn = e.target.closest('.run-btn');
  if (btn) loadRun(btn.dataset.base);
});
$('refresh-runs').addEventListener('click', loadRuns);

// ---------- Sort headers affordance ----------
document.querySelectorAll('#results-table th[data-sort]').forEach((th) => {
  th.classList.add('sortable');
});

// ---------- Init ----------
function loadLastSearch() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_SEARCH_KEY) || 'null');
    if (!saved) return;
    if (saved.industry) $('industry').value = saved.industry;
    if (saved.place) $('place').value = saved.place;
    if (saved.max) $('max').value = saved.max;
    if (typeof saved.contact === 'boolean') $('contact').checked = saved.contact;
    if (typeof saved.headless === 'boolean') $('headless').checked = saved.headless;
    if (saved.area) $('area').value = saved.area;
    if (saved.radius) $('radius').value = saved.radius;
    if (saved.tileKm) $('tileKm').value = saved.tileKm;
    if (typeof saved.subAreas === 'boolean') $('sub-areas').checked = saved.subAreas;
    if (typeof saved.keepOutside === 'boolean') $('keep-outside').checked = saved.keepOutside;
    if (typeof saved.areaMode === 'boolean') {
      $('area-mode').checked = saved.areaMode;
      state.areaMode = saved.areaMode;
      $('area-fields').classList.toggle('hidden', !saved.areaMode);
    }
    if (typeof saved.allResults === 'boolean') setAllResults(saved.allResults);
  } catch {
    /* ignore */
  }
}

loadLastSearch();
setAllResults(state.allResults);
updateQueryPreview();
renderResults();
loadRuns();
