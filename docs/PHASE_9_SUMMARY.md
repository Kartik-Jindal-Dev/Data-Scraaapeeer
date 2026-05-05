# Phase 9 Summary — Anti-Blocking

**Status:** ✅ Complete  
**Tests:** 219/219 passing (19 new + 200 from Phases 1–8)  
**Next phase:** Phase 10 — Compliance & Operations

---

## What Was Implemented

Phase 9 introduces a dedicated `antiBlocking.ts` module that centralises all fingerprint-evasion logic. Both `discovery.ts` and `scraper.ts` now launch browsers through `createStealthBrowser()` instead of calling `chromium.launch()` directly. All other logic in those modules is unchanged.

---

## Files Created / Modified

```
backend/src/pipeline/
├── antiBlocking.ts          — NEW: stealth browser factory + UA/viewport/proxy utilities
└── antiBlocking.test.ts     — NEW: 19 tests

backend/src/pipeline/
├── discovery.ts             — UPDATED: import createStealthBrowser, replace launch block
└── scraper.ts               — UPDATED: import createStealthBrowser, replace getScraperContext launch block

backend/
└── .env.example             — UPDATED: removed stale paid API keys, documented PROXY_URL
```

---

## Anti-Blocking Techniques

### 1. Stealth Plugin (`playwright-extra` + `puppeteer-extra-plugin-stealth`)

Loaded via dynamic import with graceful fallback to plain Playwright if the package is unavailable. The stealth plugin patches:
- `navigator.webdriver` → `undefined`
- Chrome automation flags
- Plugin/MIME type arrays
- Language and platform inconsistencies
- WebGL renderer strings

### 2. User-Agent Rotation

Pool of 9 real browser UA strings (Chrome/Windows, Chrome/macOS, Firefox/Windows, Edge/Windows, Chrome/Linux). A random UA is selected per browser launch.

```typescript
pickUserAgent() // → random from pool of 9
```

### 3. Viewport Rotation

Pool of 5 common screen resolutions. A random viewport is selected per browser launch.

```typescript
pickViewport() // → random from { 1920×1080, 1440×900, 1366×768, 1280×800, 1536×864 }
```

### 4. Extra HTTP Headers

Every browser context sends headers that mimic a real browser navigation:

```
Accept-Language: en-US,en;q=0.9
Accept-Encoding: gzip, deflate, br
Sec-Fetch-Dest: document
Sec-Fetch-Mode: navigate
Sec-Fetch-Site: none
Sec-Fetch-User: ?1
Upgrade-Insecure-Requests: 1
```

### 5. Init Script (belt-and-suspenders)

Applied to every context via `addInitScript()`:
- Deletes `navigator.webdriver`
- Removes Chrome DevTools Protocol artifacts (`cdc_*` globals)

### 6. Proxy Support (optional, env-based)

```env
# .env
PROXY_URL=http://user:pass@proxy.example.com:8080
# or
PROXY_URL=socks5://proxy.example.com:1080
# leave empty to disable
```

`getProxyConfig()` parses `PROXY_URL`, URL-decodes credentials, and returns a Playwright-compatible proxy config. Returns `undefined` when `PROXY_URL` is empty — no proxy overhead when not needed.

---

## Integration Pattern

Both `discovery.ts` and `scraper.ts` were updated at their browser-launch call sites only. No other logic was touched:

```typescript
// Before (Phase 2/3):
activeBrowser = await chromium.launch({ ... });
activeContext = await activeBrowser.newContext({ userAgent: '...', ... });

// After (Phase 9):
const { browser, context } = await createStealthBrowser();
activeBrowser = browser;
activeContext = context;
```

---

## Graceful Degradation

If `playwright-extra` or `puppeteer-extra-plugin-stealth` is not installed, `loadStealthChromium()` catches the import error, logs a warning, and falls back to plain `playwright.chromium`. The system continues to work — just without the stealth patches.

---

## Existing Delays Preserved

The 2–4s base delay + ±500ms jitter between Google Maps card interactions in `discovery.ts` is unchanged. Phase 9 adds fingerprint evasion on top of the existing rate-limiting behaviour.

---

## Test Coverage

| Test | Result |
|------|--------|
| `pickUserAgent()` returns a non-empty string | ✅ |
| `pickUserAgent()` contains a browser identifier | ✅ |
| `pickUserAgent()` varies across calls (pool rotation) | ✅ |
| `pickViewport()` returns width + height numbers | ✅ |
| `pickViewport()` returns reasonable dimensions | ✅ |
| `pickViewport()` varies across calls | ✅ |
| `getExtraHeaders()` returns an object | ✅ |
| `getExtraHeaders()` includes Accept-Language | ✅ |
| `getExtraHeaders()` includes Accept | ✅ |
| `getExtraHeaders()` includes Sec-Fetch-Mode | ✅ |
| `getExtraHeaders()` returns new object each call | ✅ |
| `getProxyConfig()` → undefined when PROXY_URL unset | ✅ |
| `getProxyConfig()` → undefined when PROXY_URL empty | ✅ |
| `getProxyConfig()` → undefined when whitespace only | ✅ |
| `getProxyConfig()` parses simple proxy URL | ✅ |
| `getProxyConfig()` parses proxy URL with auth | ✅ |
| `getProxyConfig()` parses SOCKS5 URL | ✅ |
| `getProxyConfig()` → undefined for invalid URL | ✅ |
| `getProxyConfig()` URL-decodes special chars in credentials | ✅ |
