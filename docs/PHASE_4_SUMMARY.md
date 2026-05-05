# Phase 4 Summary — Extraction Logic

**Status:** ✅ Complete  
**Tests:** 167/167 passing (47 new + 120 from Phases 1–3)  
**Next phase:** Phase 5 — Filter + Quality Tier + SSE Lead Events

---

## What Was Implemented

Phase 4 delivers the email and phone extraction modules. Both are wired into the pipeline after website scraping (Step 5 and Step 6). The pipeline now produces a fully-populated `extractedLeads[]` array with `email` and `phone` fields for every lead. Phase 5 will apply the post-scrape filter and push qualifying leads to the store with SSE events.

---

## Files Created

```
backend/src/pipeline/
├── emailExtractor.ts       — Email extraction from HTML
├── phoneNormalizer.ts      — Phone extraction + E.164 normalisation
├── emailExtractor.test.ts  — 25 tests
└── phoneNormalizer.test.ts — 22 tests
```

**Updated:**
```
backend/src/pipeline/pipeline.ts  — Steps 5+6 (email + phone extraction) wired in
```

---

## Email Extraction Logic

```
HTML input
  │
  ├─ Step 1: <a href="mailto:..."> elements (highest confidence)
  ├─ Step 2: regex scan of $('body').text() — /[\w.+\-]+@[\w\-]+\.[\w.]{2,}/g
  │
  ├─ Step 3: deduplicate (case-insensitive)
  │
  ├─ Step 4: blacklist filter — discard if email contains:
  │          noreply, no-reply, donotreply, do-not-reply,
  │          example.com, sentry, cloudflare, amazonaws,
  │          google, facebook, wixpress.com
  │
  ├─ Step 5: noise filter — discard if:
  │          local part > 50 chars
  │          matches: webpack@, sourcemap@, tracking@, pixel@, analytics@, error@
  │
  └─ Step 6: rank by domain priority
             1. Company-domain match (tldts root domain comparison)
             2. Non-freemail address
             3. Freemail fallback (gmail, yahoo, outlook, hotmail, etc.)
             → return single best candidate or ''
```

**Key constraint enforced:** `example.com` is in the blacklist, so the test domain was changed to `acmecorp.com` to avoid false negatives in tests.

---

## Phone Extraction Logic

```
Priority 1: rawPhone from Google Maps discovery
  → normalisePhone(rawPhone, isoCode) via libphonenumber-js
  → if valid → return E.164

Priority 2: page HTML text
  → strip <script>, <style>, HTML tags
  → scan with regex patterns:
     /\+[\d\s\-().]{7,20}/g          (international: +1 (202) 555-1234)
     /\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/g  (US/CA format)
     /\d{8,15}/g                     (bare digits)
  → normalisePhone(match, isoCode) via libphonenumber-js
  → first valid E.164 wins

If nothing found → increment phone_not_found metric → return ''
```

**ISO country code** from Phase 2 (Nominatim geocoder) is passed as `defaultRegion` to `libphonenumber-js` for all normalisation calls.

---

## Metrics Tracked

| Metric | When incremented |
|--------|-----------------|
| `email_not_found` | No email survives all filtering steps |
| `phone_not_found` | No valid phone found in discovery or page text |

Both are reset on `store.reset()` at the start of each new job.

---

## Pipeline State After Phase 4

```
POST /api/start
  → Nominatim geocode
  → Playwright Maps discovery (up to 100 raw leads)
  → Deduplication
  → Website scraping (detect → Cheerio or Playwright)
  → Email extraction (mailto + regex + blacklist + rank)  ← NEW
  → Phone normalisation (libphonenumber-js + ISO hint)    ← NEW
  → extractedLeads[] = [{ raw, html, email, phone }, ...]
  → [Phase 5: filter + quality tier + store.addLead() + emitLead()]
  → finishJob('completed')
```

---

## Constraints Verified

| Constraint | Status |
|------------|--------|
| No email guessing — only scraped emails | ✅ No domain-pattern generation anywhere |
| No filtering in Phase 4 | ✅ All leads pass through extraction |
| No SSE lead events in Phase 4 | ✅ |
| Phone in E.164 format | ✅ libphonenumber-js validates + formats |
| Discovery phone takes priority | ✅ rawPhone checked first |
| email_not_found metric incremented | ✅ |
| phone_not_found metric incremented | ✅ |
| Freemail only as last resort | ✅ company domain > non-freemail > freemail |
