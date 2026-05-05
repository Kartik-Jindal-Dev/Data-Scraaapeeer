# Phase 5 Summary — Filter + Final Pipeline

**Status:** ✅ Complete  
**Tests:** 189/189 passing (22 new + 167 from Phases 1–4)  
**Pipeline:** COMPLETE — all 12 steps wired end-to-end

---

## What Was Implemented

Phase 5 delivers the post-scrape filter, quality tier assignment, and SSE lead/discard event emission. The pipeline is now fully wired: every lead flows through geocode → discovery → dedup → scrape → extract → filter → store → SSE. The system produces qualified leads in the store and streams them to the frontend in real time.

---

## Files Created

```
backend/src/pipeline/
├── filter.ts       — Post-scrape filter + quality tier + store.addLead() + SSE emit
└── filter.test.ts  — 22 tests
```

**Updated:**
```
backend/src/pipeline/pipeline.ts  — Steps 5+6+7 combined into single per-lead loop
```

---

## Filter Logic

```
For each extracted lead { raw, email, phone }:

  IF !email AND !phone:
    → store.incrementDiscard()
    → store.incrementMetric('discard_no_contact')
    → emitDiscard(jobId, { total, leadCount, jobStatus })
    → logger.info("discarded: <name>")
    → return false

  ELSE:
    → assignQualityTier(email, phone):
         email + phone → Tier1, _hasBoth = true
         email only   → Tier2, _hasBoth = false
         phone only   → Tier3, _hasBoth = false
    → store.addLead({ businessName, email, phone, website, address, _hasBoth, _qualityTier })
    → emitLead(jobId, { businessName, email, phone, website, address })
         ↑ PublicLead only — _hasBoth and _qualityTier are NEVER in SSE payload
    → return true
```

---

## Complete Pipeline Flow (Phase 5)

```
POST /api/start { keyword, location, depth }
  │
  ├─ Nominatim geocode → ISO country code
  ├─ Playwright Maps discovery → up to 100 raw leads
  ├─ Deduplication (normalizedPhone|rootDomain via tldts)
  ├─ Website scraping (detect → Cheerio or Playwright)
  │    └─ unreachable → website_unreachable++ → continue with empty HTML
  │
  └─ Per-lead loop (extract + filter + store + SSE):
       ├─ extractEmail(html, website) → email or ''
       ├─ extractPhone(rawPhone, html, isoCode) → E.164 or ''
       ├─ processLead(jobId, { raw, email, phone }):
       │    ├─ PASS: assignQualityTier → store.addLead() → emitLead()
       │    └─ FAIL: incrementDiscard() → emitDiscard()
       └─ emitStatus() every 10 leads

  → finishJob('completed') → emitStatus + closeSSEConnection
```

---

## Constraint Verification

| Constraint | Status |
|------------|--------|
| Filter runs ONLY after all scraping + extraction | ✅ processLead() called after extractEmail + extractPhone |
| Discard if no email AND no phone | ✅ |
| discard_no_contact metric incremented on discard | ✅ |
| SSE discard event emitted on discard | ✅ |
| SSE lead event carries public fields only | ✅ _hasBoth and _qualityTier excluded |
| _hasBoth = true only for Tier1 | ✅ |
| Discarded leads NOT in store.leads[] | ✅ |
| Accepted leads pushed to store.leads[] | ✅ |
| No email guessing anywhere | ✅ |
| Phone always E.164 or empty string | ✅ |

---

## Test Coverage Summary (all phases)

| Phase | Tests | Modules |
|-------|-------|---------|
| 1 | 56 | store, sse, exporter |
| 2 | 34 | geocoder, deduplicator |
| 3 | 30 | detect, scraper |
| 4 | 47 | emailExtractor, phoneNormalizer |
| 5 | 22 | filter |
| **Total** | **189** | **10 test suites** |
