# Graph Report - Data scrapper  (2026-05-15)

## Corpus Check
- 66 files · ~806,555 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 261 nodes · 328 edges · 17 communities detected
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 32 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 22|Community 22]]

## God Nodes (most connected - your core abstractions)
1. `discoverLeads()` - 18 edges
2. `scrapePage()` - 11 edges
3. `createStealthBrowser()` - 9 edges
4. `processLead()` - 8 edges
5. `runPipeline()` - 8 edges
6. `emitStatus()` - 7 edges
7. `BrowserContextPool` - 7 edges
8. `searchSerper()` - 7 edges
9. `writeSSEEvent()` - 6 edges
10. `getDb()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `discoverLeads()` --calls--> `validateSerperResults()`  [INFERRED]
  backend\src\pipeline\discovery.ts → backend\src\pipeline\serper.ts
- `discoverLeads()` --calls--> `convertToRawLeads()`  [INFERRED]
  backend\src\pipeline\discovery.ts → backend\src\pipeline\serper.ts
- `closeSSEConnection()` --calls--> `finishJob()`  [INFERRED]
  backend\src\sse.ts → backend\src\pipeline\pipeline.ts
- `closeSSEConnection()` --calls--> `handleStop()`  [INFERRED]
  backend\src\sse.ts → backend\src\routes\stop.ts
- `emitStatus()` --calls--> `discoverLeads()`  [INFERRED]
  backend\src\sse.ts → backend\src\pipeline\discovery.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.14
Nodes (13): BrowserContextPool, closeScraperBrowser(), getDomainKey(), getOrInitPool(), getPoolSize(), isCircuitOpen(), isRetryableReason(), markUnreachable() (+5 more)

### Community 1 - "Community 1"
Cohesion: 0.17
Nodes (12): addToCache(), ConcurrencyLimiter, convertToRawLeads(), extractResultsFromResponse(), getCacheStats(), getConfig(), getFromCache(), getSerperCacheStats() (+4 more)

### Community 2 - "Community 2"
Cohesion: 0.2
Nodes (14): detectContactForm(), assignQualityTier(), discardReason(), passesContactFilter(), processLead(), broadcastStatus(), closeSSEConnection(), emitDiscard() (+6 more)

### Community 3 - "Community 3"
Cohesion: 0.18
Nodes (9): classifyEmailBounceRisk(), extractEmail(), extractFromJsonLd(), normaliseEmail(), truncateHtmlIfNeeded(), walkJsonLd(), extractPhone(), extractPhoneFromText() (+1 more)

### Community 4 - "Community 4"
Cohesion: 0.23
Nodes (10): forceCloseBrowser(), finishJob(), resetStopSignal(), runPipeline(), signalStop(), dispatchCity(), runCitySlice(), sleep() (+2 more)

### Community 5 - "Community 5"
Cohesion: 0.29
Nodes (11): countFeedItems(), discoverLeads(), dismissConsentDialog(), extractFromDetailPanel(), extractFromList(), isCaptchaPage(), normaliseUrl(), randomDelay() (+3 more)

### Community 6 - "Community 6"
Cohesion: 0.3
Nodes (8): buildBridgeForCountry(), buildCityPool(), buildMultiStateCityPool(), findRegionWithCities(), findState(), getFullRankedCities(), getStates(), resolveCountryIso()

### Community 7 - "Community 7"
Cohesion: 0.5
Nodes (6): getCurrentMigrationVersion(), getDb(), getDbStats(), initializeSchema(), runMigrations(), transaction()

### Community 8 - "Community 8"
Cohesion: 0.43
Nodes (7): createStealthBrowser(), getExtraHeaders(), getProxyConfig(), loadStealthChromium(), pickUserAgent(), pickViewport(), getScraperContext()

### Community 9 - "Community 9"
Cohesion: 0.39
Nodes (5): acquireDedupLock(), buildDedupKey(), cleanupRollingWindow(), extractRootDomain(), isDuplicateLead()

### Community 10 - "Community 10"
Cohesion: 0.48
Nodes (5): addLeadRow(), generateExcelBuffer(), generateExcelStreaming(), sortLeads(), styleHeaderRow()

### Community 11 - "Community 11"
Cohesion: 0.43
Nodes (4): buildKey(), cleanup(), isCityVisited(), markCityVisited()

### Community 12 - "Community 12"
Cohesion: 0.47
Nodes (3): fetchRobotsTxt(), isAllowedByRobots(), isPathAllowed()

### Community 13 - "Community 13"
Cohesion: 0.5
Nodes (2): runDedupCleanup(), startScheduler()

### Community 18 - "Community 18"
Cohesion: 0.83
Nodes (3): detectPageType(), getHeuristicPageType(), isLoginRedirect()

### Community 19 - "Community 19"
Cohesion: 0.83
Nodes (3): cleanLocationQuery(), fetchNominatim(), geocodeLocation()

### Community 22 - "Community 22"
Cohesion: 1.0
Nodes (2): makeLead(), makeRaw()

## Knowledge Gaps
- **Thin community `Community 13`** (5 nodes): `scheduler.ts`, `isSchedulerRunning()`, `runDedupCleanup()`, `startScheduler()`, `stopScheduler()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 22`** (3 nodes): `filter.test.ts`, `makeLead()`, `makeRaw()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `runPipeline()` connect `Community 4` to `Community 0`, `Community 9`, `Community 5`?**
  _High betweenness centrality (0.118) - this node is a cross-community bridge._
- **Why does `discoverLeads()` connect `Community 5` to `Community 8`, `Community 1`, `Community 2`, `Community 4`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `emitStatus()` connect `Community 4` to `Community 2`, `Community 5`?**
  _High betweenness centrality (0.085) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `discoverLeads()` (e.g. with `searchSerper()` and `validateSerperResults()`) actually correct?**
  _`discoverLeads()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `scrapePage()` (e.g. with `isAllowedByRobots()` and `detectPageType()`) actually correct?**
  _`scrapePage()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `createStealthBrowser()` (e.g. with `discoverLeads()` and `.initialize()`) actually correct?**
  _`createStealthBrowser()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `processLead()` (e.g. with `emitDiscard()` and `classifyEmailBounceRisk()`) actually correct?**
  _`processLead()` has 4 INFERRED edges - model-reasoned connections that need verification._