# Phase 6 Summary — Frontend Dashboard

**Status:** ✅ Complete  
**TypeScript:** 0 errors (`npx tsc --noEmit`)  
**Next phase:** Phase 7 — In-Depth Crawl

---

## What Was Implemented

Phase 6 delivers the complete Next.js 14 frontend dashboard. The UI connects to the Express backend via a Next.js rewrite proxy, streams live results via SSE, and provides Start/Stop controls and a one-click Excel export.

---

## Files Created

```
frontend/
├── package.json              — Next.js 14.2.30 (patched), React 18, Tailwind 3
├── tsconfig.json
├── next.config.js            — /api/* proxy to http://localhost:4000
├── tailwind.config.js
├── postcss.config.js
├── .env.local                — NEXT_PUBLIC_API_URL=http://localhost:4000
└── src/
    ├── types.ts              — Lead, JobStatus, ScrapeDepth, SSE payload types
    ├── hooks/
    │   └── useSSE.ts         — EventSource hook, auto-closes on terminal status
    ├── components/
    │   ├── InputPanel.tsx    — keyword, location, depth radio, Start/Stop buttons
    │   ├── StatusBar.tsx     — live status badge, lead count, discard count, spinner
    │   ├── ResultsTable.tsx  — 5-column table, green rows for both-contact leads
    │   └── ExportButton.tsx  — window.location.href export trigger
    └── app/
        ├── layout.tsx        — root layout, Tailwind globals
        ├── page.tsx          — dashboard: all state, SSE wiring, API calls
        └── globals.css       — @tailwind directives
```

---

## Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| `page.tsx` | All state (leads, status, jobId, errors). Calls `/api/start` and `/api/stop`. Wires `useSSE`. |
| `useSSE.ts` | Opens `EventSource(/api/stream?jobId=...)`. Handles `lead`, `discard`, `status`, `error` events. Closes on terminal status. |
| `InputPanel.tsx` | Controlled inputs for keyword, location, depth. Disables during run. Shows location validation error. |
| `StatusBar.tsx` | Displays current `JobStatus`, lead count, discard count, running spinner, non-fatal error messages. |
| `ResultsTable.tsx` | Renders leads array. Green row highlight when both email and phone present. Mailto/tel/href links. |
| `ExportButton.tsx` | Enabled only when `status === 'completed' \| 'stopped'` and `leadCount > 0`. Triggers browser download. |

---

## SSE Event Handling

| Event | Action |
|-------|--------|
| `lead` | Append to `leads[]` state → table row appears immediately |
| `discard` | Update `discardCount` state |
| `status` | Update `jobStatus` + `discardCount`. Close EventSource on `completed/stopped/error`. |
| `error` | Display non-fatal warning in StatusBar |

---

## How to Run

```bash
# Terminal 1 — Backend
cd backend
npm run dev
# → http://localhost:4000

# Terminal 2 — Frontend
cd frontend
npm run dev
# → http://localhost:3000
```

The Next.js rewrite in `next.config.js` proxies all `/api/*` requests to `http://localhost:4000`, so the frontend and backend can run on different ports without CORS issues.

---

## Security Note

Next.js 14.2.30 is used (patched version for the 14.x line). The critical RCE vulnerability CVE-2025-66478 only affects Next.js 15.x/16.x with React 19 RSC — this project uses Next.js 14 with no RSC data fetching and is not affected.

---

## Accessibility

- All inputs have `<label>` elements with `htmlFor`
- Depth toggle uses `role="radiogroup"` with `aria-label`
- Status bar uses `role="status"` and `aria-live="polite"`
- Location error uses `role="alert"` and `aria-describedby`
- Table uses `aria-label` and `scope="col"` on headers
- Buttons have descriptive `aria-label` attributes
- Links have `aria-label` with business name context
