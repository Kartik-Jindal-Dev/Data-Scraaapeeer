/**
 * index.ts
 * Express server entry point for the Lead Generation Scraper backend.
 *
 * Routes:
 *   POST /api/start   — start a new scrape job
 *   POST /api/stop    — stop the running job (10s hard timeout)
 *   GET  /api/status  — current job status + stats + failure metrics
 *   GET  /api/stream  — SSE stream of lead/discard/status/error events
 *   GET  /api/export  — download leads as .xlsx
 *   GET  /api/jobs    — job history and management (Phase 21)
 *
 * Phase 21 - Database Integration:
 * - SQLite database for persistent storage
 * - Data survives server restarts
 * - Job history tracking
 * - 15-day rolling dedup window
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { logger } from "./logger";
import { startRouter } from "./routes/start";
import { stopRouter } from "./routes/stop";
import { statusRouter } from "./routes/status";
import { streamRouter } from "./routes/stream";
import { exportRouter } from "./routes/export";
import { exportStreamRouter } from "./routes/exportStream";
import { locationsRouter } from "./routes/locations";
import { jobsRouter } from "./routes/jobs";
import { startScheduler } from "./scheduler";

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
const PORT = parseInt(process.env.PORT ?? "8080", 10);

// Trust first proxy hop for correct IP detection behind nginx/load balancer
// Required for express-rate-limit to use the real client IP
app.set("trust proxy", 1);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  }),
);

app.use(express.json({ limit: "1mb" }));

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── API Routes ───────────────────────────────────────────────────────────────

app.use("/api/start", startRouter);
app.use("/api/stop", stopRouter);
app.use("/api/status", statusRouter);
app.use("/api/stream", streamRouter);
app.use("/api/export/stream", exportStreamRouter);
app.use("/api/export", exportRouter);
app.use("/api/locations", locationsRouter);
app.use("/api/jobs", jobsRouter);

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "not_found", message: "Endpoint not found" });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    logger.error(`Unhandled error: ${err.message}`);
    res.status(500).json({
      error: "internal_error",
      message: "An unexpected error occurred",
    });
  },
);

// ─── Start Server ─────────────────────────────────────────────────────────────

const server = app.listen(PORT, "0.0.0.0", () => {
  logger.info(`Lead Scraper backend running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV ?? "development"}`);

  // Start the dedup cleanup scheduler (Phase 21)
  const testMode = process.env.NODE_ENV === "test";
  startScheduler(testMode);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });

  // Force exit after 15 seconds if graceful shutdown stalls
  setTimeout(() => {
    logger.warn("Forced shutdown after 15s timeout");
    process.exit(1);
  }, 15_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Playwright CDP Crash Guard ───────────────────────────────────────────────
// playwright-extra's puppeteer compatibility shim can throw unhandled promise
// rejections (cdpSession.send: Target page, context or browser has been closed)
// when a browser is closed while a page operation is still in flight.
// These are benign — the scraper already handles them via try/catch — but Node
// will crash the process if they go unhandled. We catch and log them here.
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const isCdpCrash =
    msg.includes("cdpSession.send") ||
    msg.includes("Target page, context or browser has been closed") ||
    msg.includes("browser has been closed") ||
    msg.includes("context has been closed") ||
    msg.includes("Target closed") ||
    msg.includes("Session closed");

  if (isCdpCrash) {
    logger.warn(
      `Scraper: suppressed Playwright CDP rejection — ${msg.slice(0, 120)}`,
    );
    return; // swallow — not a real crash
  }

  // All other unhandled rejections are real errors — log and let Node handle them
  logger.error(`Unhandled rejection: ${msg}`);
});

export default app;
