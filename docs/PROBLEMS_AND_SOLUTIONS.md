# Known Problems & Solutions

> Based on real issues encountered during development and production runs.
> Ordered by severity — most critical first.

---

## 1. App Crashes Mid-Run (CDP Session Error)

**Symptom:**
```
cdpSession.send: Target page, context or browser has been closed
[nodemon] app crashed - waiting for file changes before starting...
```

**Root cause:**
`playwright-extra`'s puppeteer compatibility shim fires a background async operation
on a browser session that was already closed. This becomes an unhandled promise
rejection that crashes the Node.js process.

**When it happens:**
- Long multi-run jobs (5×5 = 25 runs) where the browser is closed between runs
- When a Playwright timeout occurs and the retry fires after the browser is already gone
- After ~60–90 minutes of continuous scraping

**Solutions (applied):**
1. `SCRAPE_MAX_RETRIES=0` — retries disabled. Retries were the trigger: they waited
   2s after a timeout, during which the browser closed, then tried to reuse the dead session.
2. Global `unhandledRejection` handler in `index.ts` — catches any stray CDP errors
   that escape the try/catch blocks and logs them as warnings instead of crashing.

**If it still happens:**
- Restart the server and re-run. The crash guard is now in place.
- Add `PROXY_URL` — a proxy reduces Playwright timeouts which were the original trigger.

---

## 2. Google Maps Results Feed Not Found (0 leads)

**Symptom:**
```
Discovery: results feed not found. The page structure may have changed.
Pipeline: discovery returned 0 raw leads
```

**Root cause:**
Google Maps occasionally changes its DOM structure, or shows a different layout
(consent wall, CAPTCHA, A/B test variant) that doesn't match the expected selectors.

**Solutions (applied):**
1. Multi-selector fallback — tries 5 different CSS selectors in parallel:
   `[role="feed"]`, `div[aria-label*="Results for"]`, `.m6QErb[aria-label]`, `#QA0Szd`
2. Alternate URL format retry — if the first URL fails, retries with
   `?q=<query>&hl=en` format
3. Flexible card extraction — falls back to place-link ancestors if direct div
   children are empty

**If it still happens:**
- Wait 5–10 minutes and retry — often a temporary Google block
- Use a different IP or add `PROXY_URL`
- Check `logs/scraper.log` for the feed sample to diagnose the actual DOM

---

## 3. CAPTCHA Block During Discovery

**Symptom:**
```
Discovery: CAPTCHA detected on Google Maps. Try again later or use a different IP.
captcha_blocked metric incremented
```

**Root cause:**
Google detects automated browser activity and shows a CAPTCHA challenge.
More likely after extended scraping sessions (>60 min) from the same IP.

**Solutions:**
1. **Add a proxy** — Set `PROXY_URL` in `.env`. Residential proxies (Bright Data,
   Smartproxy) are most effective. ~$3–8/month.
2. **Increase delays** — `REQUEST_DELAY_MS=1000` and `REQUEST_DELAY_JITTER_MS=500`
   make the scraper look more human.
3. **Split large jobs** — Instead of 5×5 in one job, run 3×3 then 2×2 with a
   15-minute break between.
4. **Run at off-peak hours** — Early morning (2–6 AM local time) has lower detection rates.

**Current `.env` settings for CAPTCHA resistance:**
```env
REQUEST_DELAY_MS=800
REQUEST_DELAY_JITTER_MS=400
PROXY_URL=http://user:pass@proxy.example.com:8080
```

---

## 4. DNS Resolution Failed (Sites Marked Unreachable)

**Symptom:**
```
Scraper: DNS resolution failed — http://www.somesite.com
Scraper [X/Y]: "Business Name" — unreachable
```

**Root cause:**
The business's domain no longer exists (expired, moved, or never had a website).
Google Maps listings often contain outdated website URLs.

**This is expected behaviour** — the DNS check was added intentionally to skip
dead domains quickly instead of waiting 12 seconds for a Playwright timeout.

**Impact:** ~5–15% of leads in older Google Maps listings have dead domains.
These leads may still qualify via phone number from discovery.

**No fix needed.** If you want to disable the DNS check (not recommended):
Remove the DNS pre-resolution block in `scraper.ts`.

---

## 5. Phone Numbers Showing as Ratings (e.g. "4.9(283)")

**Symptom:**
```
PhoneNormalizer: discovery phone "4.9(283)" invalid for "Business Name" — trying page
```

**Root cause:**
Google Maps inline list extraction sometimes picks up the star rating + review count
(e.g. "4.9(283)") instead of the phone number. This happens when the phone is not
shown inline and the rating appears in a similar DOM position.

**Solutions (applied):**
1. The phone regex requires the string to start with `+` or a digit and match
   `[\d\s\-().]{6,14}` — ratings like "4.9(283)" fail this pattern.
2. Fallback to detail panel navigation for leads missing both phone AND website.
3. Fallback to page scraping — `PhoneNormalizer` tries to extract the phone from
   the business website if the discovery phone is invalid.

**Result:** Most of these leads still get a valid phone from their website.
Leads that end up with no phone AND no email are discarded.

---

## 6. Emails Failing MX Validation

**Symptom:**
```
EmailExtractor: all 2 email(s) failed MX validation for https://www.somesite.com
```

**Root cause:**
The email domain has no MX records — the domain exists but is not configured to
receive email. Common for:
- Placeholder/parked domains
- Businesses that use a different domain for email than their website
- Recently expired email hosting

**Solutions:**
1. MX validation is intentional — it prevents bounce-prone emails from reaching
   the export. This is working as designed.
2. If you want to disable MX validation (accept all syntactically valid emails):
   Comment out Step 5.5 in `emailExtractor.ts`.

**Trade-off:** Disabling MX validation increases email yield by ~10–15% but also
increases bounce rate on outreach campaigns.

---

## 7. Frontend Only Shows Last Run's Data (Multi-Run Bug)

**Symptom:**
Running 3×3 (9 combinations) but the frontend table only shows leads from the
last combination. Earlier leads disappear.

**Root cause (fixed):**
`pipeline.ts` was calling `closeSSEConnection()` after every individual run,
killing the EventSource connection. Subsequent runs emitted leads into a dead stream.

**Solution (applied):**
`runPipeline()` now accepts an `isIntermediate` flag. Intermediate runs emit
`status: 'running'` instead of `completed` and do NOT close the SSE connection.
Only the final run closes the connection.

**If you see this again:**
Check that `start.ts` is passing `isIntermediate = !isLastRun` correctly.

---

## 8. App Runs But Returns 0 Qualified Leads

**Symptom:**
Discovery finds 80+ businesses but all are discarded. Lead count stays at 0.

**Possible causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| Contact filter set to `email_only` | Check UI filter setting | Change to `any` |
| All emails failing MX validation | Check logs for "failed MX validation" | Disable MX check or use `any` filter |
| All websites unreachable | Check `website_unreachable` metric | Normal for some industries |
| Discovery returning rating strings as phones | Check logs for "4.x(xxx) invalid" | Normal — phones extracted from websites |
| Wrong location (no businesses) | Check discovery log for 0 results | Use a more specific location |

---

## 9. Server Crashes on Restart / Data Lost

**Symptom:**
Server restarts (nodemon, pm2 restart, manual restart) and all leads are gone.

**Root cause:**
This is by design — all data is in-memory only (Constraint #2). Restarting the
server clears everything.

**Solutions:**
1. **Export before restarting** — Always click Export to Excel before stopping the server.
2. **Auto-export on completion** — Not yet implemented. Would require relaxing
   Constraint #2 (no file writes).
3. **SQLite persistence** — Future upgrade option. See `docs/UPGRADES.md §10.2`.

---

## 10. Slow Performance on Large Runs

**Symptom:**
5×5 job takes 3+ hours. Individual runs take 10+ minutes each.

**Root cause analysis:**

| Stage | Time | Bottleneck |
|-------|------|-----------|
| Discovery (Google Maps) | 30–60s/run | Scrolling + inline extraction |
| Static detection | Up to 3s/site | `DETECTION_TIMEOUT_MS` too high |
| Dynamic scraping | Up to 12s/site | `GLOBAL_SITE_TIMEOUT_MS` |
| MX validation | 0.5–2s/domain | DNS lookup (cached after first hit) |

**Solutions (applied):**
- `DETECTION_TIMEOUT_MS=1000` — reduced from 3000ms
- `SCRAPE_CONCURRENCY=10` — 10 parallel scrapers
- `RESPECT_ROBOTS_TXT=false` — skips robots.txt fetch per domain
- Inline list extraction — avoids per-place navigation for ~70% of results

**Further improvements:**
- Add `PROXY_URL` — reduces Playwright timeouts which are the main time sink
- Use Outscraper API — drops discovery from 30–60s to ~5s per run
- Run `homepage` depth only — `indepth` mode is 3× slower

---

## 11. Duplicate Leads Across Multiple Jobs

**Symptom:**
Running two separate jobs (e.g. Job 1: Texas, Job 2: Ohio) produces duplicate
businesses in the combined Excel export.

**Root cause:**
The dedup set is cleared on `store.reset()` which runs at the start of each new job.
Cross-job deduplication is not implemented.

**Solutions:**
1. **Excel dedup** — After combining exports, use Excel's "Remove Duplicates" on
   the Phone column. Phone numbers are in E.164 format so exact matching works.
2. **Cross-run dedup** — Future upgrade. Would require a persistent `seen_keys.json`
   file (relaxes Constraint #2). See `docs/UPGRADES.md §5.4`.

---

## 12. Google Maps DOM Selectors Break

**Symptom:**
Discovery returns 0 results even though the feed is found. Feed sample shows
unexpected class names.

**Root cause:**
Google periodically updates Maps' CSS class names (obfuscated classes like `b1Ugz`,
`Hk4XGb`). The inline extraction relies on stable selectors like `.fontHeadlineSmall`,
`.W4Efsd`, and `a[href*="/maps/place/"]`.

**Diagnosis:**
Check the feed sample in the logs:
```
Discovery: 0 inline results. Feed sample:
b1Ugz Hk4XGb | <div class="k7NgRd" style="height: 180px;"></div>
```
If the feed contains only placeholder divs (height-only divs), Google is lazy-loading
and the scroll didn't trigger content load.

**Solutions:**
1. Increase `SCROLL_PAUSE_MS` in `discovery.ts` from 1200ms to 2000ms
2. Update the CSS selectors in `extractFromList()` to match the new class names
3. Use the detail panel fallback — it navigates to each place URL directly and
   uses stable `data-item-id` attributes

---

## Quick Reference: Error → Fix

| Error message | Likely cause | Quick fix |
|--------------|-------------|-----------|
| `cdpSession.send: Target...closed` | Playwright CDP crash | Already fixed — restart server |
| `results feed not found` | Google DOM change or block | Wait 5 min, retry |
| `CAPTCHA detected` | IP blocked by Google | Add `PROXY_URL` |
| `DNS resolution failed` | Dead domain | Expected — lead may still qualify via phone |
| `all X email(s) failed MX validation` | No MX records on domain | Expected — bounce protection |
| `0 raw leads` | No results for query | Try different keyword or location |
| `discovery phone "4.x(xxx)" invalid` | Rating picked up as phone | Expected — fallback to page scraping |
| `no email or phone found` | Lead has no contact info | Expected — discarded correctly |
| `rate_limit_exceeded` | Too many /api/start calls | Wait 60 seconds |
| `job_already_running` | Previous job still active | Click Stop first |

---

*Last updated: May 2026*
