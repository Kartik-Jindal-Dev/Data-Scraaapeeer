# Operational Runbook — Lead Generation Scraper

> Last updated: Phase 10

---

## 1. How to Start the System

### Prerequisites

- Node.js 20 LTS installed
- Playwright Chromium installed (`npx playwright install chromium`)
- `.env` file configured (copy from `backend/.env.example`)

### Local Development

```bash
# Terminal 1 — Backend
cd backend
cp .env.example .env      # fill in any optional values
npm install
npm run dev
# → Server starts on http://localhost:4000
# → Logs written to logs/app.log

# Terminal 2 — Frontend
cd frontend
npm install
npm run dev
# → UI available at http://localhost:3000
```

### Production (VPS with pm2)

```bash
cd backend
npm run build
npm run start:pm2

# Monitor
pm2 logs lead-scraper
pm2 monit

# Auto-restart on reboot
pm2 save
pm2 startup
```

---

## 2. How to Run a Job

1. Open `http://localhost:3000` in your browser.
2. Enter a **keyword** (e.g. `dental clinic`) and **location** (e.g. `London, UK`).
3. Select **depth**: Homepage only (faster) or In-depth (scrapes contact/about pages).
4. Click **▶ Start**.
5. Watch leads appear in the table in real time.
6. When the job completes (or you click **■ Stop**), click **↓ Export to Excel**.

**Important:** Export before starting a new job or restarting the server — all data is in memory only.

### Rate Limit

`POST /api/start` is limited to **5 requests per minute per IP**. If you hit the limit, wait 60 seconds before starting another job.

---

## 3. How to Debug Failures

### Check the log file

```bash
tail -f backend/logs/app.log
```

Key log patterns:

| Pattern | Meaning |
|---------|---------|
| `CAPTCHA detected` | Google Maps blocked the scraper — wait and retry, or use a proxy |
| `Geocode failed` | Location string not recognised by Nominatim — check spelling |
| `website_unreachable` | Business website returned 4xx/5xx or timed out — normal, lead may still qualify |
| `robots.txt disallowed` | Site's robots.txt blocks scraping — lead skipped |
| `Pipeline: unhandled error` | Unexpected crash — check full stack trace in log |
| `stealth plugin loaded` | Anti-blocking active (good) |
| `falling back to plain Playwright` | playwright-extra not installed — run `npm install` |

### Check job status via API

```bash
curl http://localhost:4000/api/status
```

Returns: `status`, `leadCount`, `discardCount`, `failureMetrics`.

### Common issues

| Issue | Fix |
|-------|-----|
| `Error: browserType.launch: Executable doesn't exist` | Run `npx playwright install chromium` |
| SSE stream not updating | Check nginx has `proxy_buffering off` |
| CAPTCHA immediately | Switch to a different IP or add `PROXY_URL` in `.env` |
| Phone numbers not normalising | Check geocode returned a valid ISO code in logs |
| Export produces empty file | Job must be `completed` or `stopped` before exporting |
| `rate_limit_exceeded` on /api/start | Wait 60 seconds |

---

## 4. How to Stop Safely

### Via UI

Click **■ Stop** in the dashboard. The job will terminate within 10 seconds. The leads collected so far are preserved — export immediately.

### Via API

```bash
curl -X POST http://localhost:4000/api/stop
```

### Via pm2 (production)

```bash
pm2 stop lead-scraper     # stops the process, preserves in-memory data until restart
pm2 restart lead-scraper  # restarts — ALL in-memory data is lost
```

**Always export before restarting.**

---

## 5. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Express server port |
| `NODE_ENV` | `development` | `development` or `production` |
| `MAX_LEADS_PER_RUN` | `100` | Max raw leads to discover per job |
| `SCRAPE_DEPTH` | `homepage` | Default depth (overridden by UI) |
| `RESPECT_ROBOTS_TXT` | `false` | Skip URLs disallowed by robots.txt (set true to re-enable) |
| `SCRAPE_CONCURRENCY` | `10` | Parallel website scraping workers |
| `REQUEST_DELAY_MS` | `500` | Base delay for fallback Maps navigations (ms) |
| `REQUEST_DELAY_JITTER_MS` | `200` | Random jitter added to delay (ms) |
| `PLAYWRIGHT_LOAD_TIMEOUT_MS` | `8000` | Playwright page load timeout (ms) |
| `GLOBAL_SITE_TIMEOUT_MS` | `12000` | Hard per-site scraping timeout (ms) |
| `DETECTION_TIMEOUT_MS` | `1000` | Static page detection fetch timeout (ms) |
| `PROXY_URL` | _(empty)_ | Optional proxy: `http://user:pass@host:port` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FILE` | `./logs/app.log` | Log file path |
| `FRONTEND_URL` | `http://localhost:3000` | CORS allowed origin |

---

## 6. Known Limitations

**Data is not persisted.** All leads live in Node.js process memory. Restarting the server clears everything. Export before restarting.

**Google Maps DOM may change.** The discovery scraper uses CSS selectors that could break if Google updates their Maps UI. If discovery returns 0 leads, check the selectors in `pipeline/discovery.ts`.

**CAPTCHA.** Google Maps may show a CAPTCHA after extended scraping sessions. The system detects it, logs it, and stops discovery. Mitigation: wait, use a different IP, or set `PROXY_URL`.

**Nominatim rate limit.** The geocoder respects Nominatim's 1 req/s limit. Do not run multiple instances against the same IP.

**Email extraction accuracy.** Expect ~30–50% of business websites to yield a valid email. Many businesses use contact forms instead of publishing email addresses.

**Phone extraction accuracy.** Higher (~60–70%) since Google Maps usually provides a phone number directly.

**LinkedIn excluded.** LinkedIn is not scraped in any phase — aggressive bot detection and legal risk.

**Vercel not supported.** The backend requires a persistent process (Playwright/Chromium). Deploy to a VPS or local machine.

---

## 7. Log File Management

Logs are written to `backend/logs/app.log`. Winston rotates at 10 MB, keeping 5 files (`app.log`, `app.log.1`, ..., `app.log.5`).

To clear logs manually:

```bash
# Windows
del backend\logs\app.log*

# Linux/macOS
rm backend/logs/app.log*
```

---

## 8. nginx Configuration (VPS)

Required for SSE to work correctly behind nginx:

```nginx
location /api/ {
    proxy_pass http://localhost:4000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;        # REQUIRED for SSE
    proxy_cache off;            # REQUIRED for SSE
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Without `proxy_buffering off`, SSE events will not reach the browser in real time.
