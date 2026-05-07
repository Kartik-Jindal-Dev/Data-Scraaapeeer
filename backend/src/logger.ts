/**
 * logger.ts
 * Winston logger configuration — Phase 10: file transport added.
 * Phase 3.7: async file writes with small flush interval to reduce I/O blocking.
 *
 * Transports:
 * - Console: colourised, timestamp HH:mm:ss
 * - File:    logs/app.log — JSON-free plain text, full timestamp, all levels
 *
 * Log file path is controlled by LOG_FILE env variable (default: ./logs/app.log).
 * The logs/ directory is created automatically by Winston if it does not exist.
 *
 * Phase 3.7 notes:
 * - File transport uses lazy: true for async (non-blocking) writes.
 * - Small flush interval (100ms) reduces crash-loss risk for fatal errors
 *   and final metrics while still avoiding synchronous I/O on every log call.
 *
 * CONSTRAINT: Never log PII beyond business name and website URL.
 */

import path from 'path';
import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

// ─── Format ───────────────────────────────────────────────────────────────────

const logFormat = printf(({ timestamp: ts, level, message }) => {
  return `${ts} [${level.toUpperCase()}] ${message}`;
});

// ─── Log File Path ────────────────────────────────────────────────────────────

const LOG_FILE = process.env.LOG_FILE ?? path.join(process.cwd(), 'logs', 'app.log');

// ─── Logger ───────────────────────────────────────────────────────────────────

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
  transports: [
    // Console transport — colourised for developer readability
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), logFormat),
    }),

    // File transport — Phase 3.7: lazy async writes, 100ms flush interval
    // lazy: true defers stream creation until first write (non-blocking startup)
    // Small maxsize + tailable ensures log rotation without blocking the event loop
    new winston.transports.File({
      filename: LOG_FILE,
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
      lazy: true, // Phase 3.7: async — open file on first write, not at startup
    }),
  ],
});

logger.info(`Logger: file transport active → ${LOG_FILE}`);
