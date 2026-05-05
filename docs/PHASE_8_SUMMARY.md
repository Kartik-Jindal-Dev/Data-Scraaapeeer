# Phase 8 Summary — In-Depth Crawl

**Status:** ✅ Complete  
**Tests:** 200/200 passing (11 new + 189 from Phases 1–7)  
**Next phase:** Phase 9 — Anti-Blocking

---

## What Was Implemented

Phase 8 activates when the operator selects `depth = indepth`. Instead of scraping only the homepage, the pipeline now scrapes the homepage plus up to 3 sub-pages (contact, about, team, etc.) per lead. All HTML is merged into a single string and passed to the existing email/phone extractors — no changes to extraction or filter logic.

---

## Files Created / Modified

```
backend/src/pipeline/
├── indepth.ts          — NEW: scrapeInDepth() — homepage + max 3 sub-pages
└── indepth.test.ts     — NEW: 11 tests

backend/src/
├── types.ts            — UPDATED: added subpages_scraped to FailureMetrics
├── store.ts            — UPDATED: initialise + reset subpages_scraped counter
└── pipeline/
    └── pipeline.ts     — UPDATED: depth branch (indepth → scrapeInDepth, homepage → scrapePage)
```

---

## In-Depth Crawl Logic

```
scrapeInDepth(websiteUrl, stopSignal, businessName)
  │
  ├─ 30s hard timeout wraps entire operation (Promise.race)
  │
  ├─ Step 1: scrapePage(websiteUrl)  ← reuses Phase 3 static/dynamic detection
  │    └─ unreachable → return { unreachable: true }
  │
  ├─ Step 2: extractContactSubPageUrls(homepageHtml, finalUrl)
  │    └─ returns up to 3 URLs matching /contact, /about, /team, /staff, /leadership
  │       (same-domain only — enforced by extractContactSubPageUrls)
  │
  ├─ Step 3: for each subPageUrl (max 3):
  │    ├─ check stopSignal.stopped → break if true
  │    ├─ skip if URL already visited (Set-based dedup)
  │    ├─ scrapePage(subPageUrl)
  │    │    ├─ success → append HTML to htmlParts[], increment subpages_scraped
  │    │    └─ unreachable → log, continue (non-fatal)
  │    └─ continue to next sub-page
  │
  └─ Step 4: join htmlParts with '\n<!-- PAGE_BREAK -->\n'
       → return { mergedHtml, finalUrl, unreachable: false, subpagesScraped }
```

---

## Pipeline Integration

```typescript
// pipeline.ts — Step 4 (website scraping)
if (depth === 'indepth') {
  const result = await scrapeInDepth(raw.website, stopSignal, raw.name);
  html = result.unreachable ? '' : result.mergedHtml;
} else {
  const result = await scrapePage(raw.website);
  html = result.unreachable ? '' : result.html;
}
// Steps 5+6+7 (extract → filter → store → SSE) unchanged — work on merged HTML
```

The merged HTML is passed directly to `extractEmail()` and `extractPhone()` — both already handle multi-page HTML correctly since they scan the full string.

---

## New Metric: `subpages_scraped`

| Metric | When incremented |
|--------|-----------------|
| `subpages_scraped` | Each sub-page successfully fetched (not homepage, not unreachable sub-pages) |

Exposed via `GET /api/status` in `failureMetrics`. Reset on `store.reset()` at the start of each new job.

---

## Limits and Constraints

| Constraint | Value | Enforcement |
|------------|-------|-------------|
| Max sub-pages per lead | 3 | `.slice(0, MAX_SUBPAGES)` in `indepth.ts` |
| Total per-lead timeout | 30s | `Promise.race` with `setTimeout` |
| Same-domain only | ✅ | `extractContactSubPageUrls` checks `hostname` |
| No recursion | ✅ | 1 hop from homepage only |
| Stop signal respected | ✅ | Checked before each sub-page fetch |
| Duplicate URL guard | ✅ | `Set<string>` of visited URLs |
| Sub-page failure is non-fatal | ✅ | Logs and continues; homepage HTML still returned |
| No changes to extraction/filter | ✅ | `extractEmail` / `extractPhone` / `processLead` untouched |

---

## Test Coverage

| Test | Result |
|------|--------|
| Empty URL → unreachable, no scrapePage call | ✅ |
| Homepage unreachable → no sub-pages attempted | ✅ |
| No sub-pages found → homepage HTML only | ✅ |
| 2 sub-pages found → all scraped, HTML merged | ✅ |
| Max 3 sub-pages enforced (5 found → 3 scraped) | ✅ |
| Duplicate sub-page URLs skipped | ✅ |
| Sub-page unreachable → continues, homepage returned | ✅ |
| Stop signal → sub-pages aborted, homepage returned | ✅ |
| `subpages_scraped` incremented per successful sub-page | ✅ |
| `subpages_scraped` NOT incremented for unreachable sub-pages | ✅ |
| `subpages_scraped` resets on `store.reset()` | ✅ |
