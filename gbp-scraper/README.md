# GBP Scraper

Google Business Profile (Google Maps) scraper built with Playwright + `playwright-extra` stealth.
Extracts business details per listing, discovers contact email/social links from the business
website, and writes JSONL (checkpoint), JSON and CSV. Ships with both a **web UI** and a **CLI**.

## Setup

```bash
npm install
npx playwright install chromium
```

## Web UI (recommended)

```bash
npm run ui
```

Opens http://localhost:3000 (set `PORT` to change; `NO_OPEN=1` to skip auto-opening).

The dashboard lets you:

- Enter an **Industry** and a **Place** (e.g. "web development agencies" + "Nairobi") — the query
  becomes `"<industry> in <place>"`.
- **All results** toggle — scrolls every search unit until Google reports the end of the list
  and clicks "See more" if it appears. One query is capped (~40–80), so small-area mode is
  what gets past that cap.
- **Small area** mode — search by a street/road/district (e.g. "Ngong Road, Nairobi") with a
  radius (default 3 km). The scraper tries several query variants (`in/near` + sub-areas) and
  filters results to that radius using the listing coordinates from Google Maps.
- Watch **live progress**: status, progress bar, current listing and a streaming log.
- **Stop** a run at any time (closes the browser; partial results are kept).
- Browse a **results table** with sorting and filters (text, min rating, has email, has website).
- Click any row for a **detail drawer** (hours, reviews, socials, Google Maps link).
- **Export** the current run to CSV or JSON.
- Reopen any **past run** from the history list.

API endpoints (used by the UI): `POST /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events`
(SSE), `POST /api/jobs/:id/stop`, `GET /api/runs`, `GET /api/runs/:base`, `GET /api/runs/:base.csv|.json`.

## CLI

```bash
node scraper.js "<search query>" [maxResults] [options]
node scraper.js --industry "web development agencies" --place "Nairobi" --max 30
node scraper.js --industry "coffee shops" --area "Ngong Road, Nairobi" --radius 3 --all
node scraper.js --industry "dentists" --area "Karen, Nairobi" --radius 2 --sub-areas --all
```

Examples:

```bash
node scraper.js "web development agencies in Nairobi" 30
node scraper.js "coffee shops in Nairobi" 20 --headless --proxy-file proxies.txt
node scraper.js "dentists in London" 50 --proxy http://user:pass@host:port
```

### Options

| Flag | Description |
|---|---|
| `--industry <text>` | Industry / business type (pairs with `--place`) |
| `--place <text>` | Location to search |
| `--area <text>` | Small area: street, road, district or neighbourhood (e.g. "Ngong Road, Nairobi") |
| `--radius <km>` | Radius for small-area filtering (default `3`) |
| `--tile-km <km>` | Tile size (used by the area grid, default `2`) |
| `--lat <n>` / `--lng <n>` | Set the area centre manually (skips geocode) |
| `--sub-areas` | Also scan sub-areas Google lists for the area |
| `--keep-outside` | Keep listings outside the area/radius |
| `--max <n>` | Max results (or pass as the 2nd positional) |
| `--all` | No cap: try multiple query variants + scroll until exhausted / "See more" handled |
| `--headless` | Run headless (default is headed, friendlier to Google) |
| `--no-contact` | Skip email/social discovery on business websites |
| `--proxy <url>` | Single proxy: `http://user:pass@host:port` |
| `--proxy-file <f>` | Proxy list (one URL per line), rotated every 25 listings |
| `--out <dir>` | Output directory (default `./output`) |
| `--delay <min[:max]>` | Human delay in ms between actions (default `800:2400`) |
| `--resume <jsonl>` | Resume a run, skipping already-scraped URLs |
| `--help` | Show help |

## Output

For each run, in `output/`:

- `gbp_<timestamp>.jsonl` — one JSON record per line, appended as it is scraped (crash-safe checkpoint)
- `gbp_<timestamp>.json` — full array of records
- `gbp_<timestamp>.csv` — flattened, Excel-friendly (UTF-8 BOM), flattened hours/reviews
- `gbp_<timestamp>.meta.json` — query/industry/place, options, status and counts (powers the history list)

Fields: `title, category, address, phone, website, email, facebook, instagram, linkedin,
twitter, youtube, tiktok, whatsapp, plusCode, rating, reviewsCount, hours, reviews, url, scrapedAt, lat, lng, distanceKm, area, areaMatch`.

### Resume

```bash
node scraper.js "coffee shops in Nairobi" 60 --resume output/gbp_2026-10-14T13-28-58-945Z.jsonl
```

Existing records are carried into the final JSON/CSV; only new listings are fetched.

## How it handles Google's defenses

| Defense | Mitigation |
|---|---|
| JS-rendered UI | Playwright Chromium |
| `navigator.webdriver` / automation fingerprint | `playwright-extra` + stealth plugin + init script |
| Automation launch flag | `--disable-blink-features=AutomationControlled` |
| Fixed-timing signals | randomized `humanDelay` + scroll steps |
| Consent wall | auto-accepts the consent screen |
| Infinite scroll feed | `humanScroll` with real end-of-list detection |
| Rate limiting | configurable delays + proxy rotation |

## Known issues / caveats

1. **Obfuscated class names** (e.g. `.HlvSq`, `.MyEned`) change without notice. Selectors here
   prefer stable attributes (`data-item-id`, `aria-label`, roles), but things can still break.
2. **Hours** open a panel sub-view; the scraper clicks "Back" to restore the overview before
   reading reviews. If Google changes that flow, hours or reviews may come back empty.
3. **Reviews** are a preview only (up to ~10). Long review text is truncated by Google unless
   each "More" link is expanded.
4. **Language**: detail pages are forced to `?hl=en`. Search-result category text can still
   reflect the account region.
5. **Blocking**: at higher volumes Google may serve an "unusual traffic" wall. The scraper
   detects it and pauses; use a residential proxy or lower the volume.
6. **Proxy rotation** is per-launch (Playwright limitation), so the browser is relaunched every
   25 listings when a proxy list is supplied.
7. **Legal**: scraping Google Maps violates Google's ToS. Use for research/personal projects;
   use the official Places API for production. Privacy laws (GDPR etc.) may apply to stored data.
