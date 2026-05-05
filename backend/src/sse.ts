/**
 * sse.ts
 * Server-Sent Events manager.
 *
 * CONSTRAINTS (from docs/CONSTRAINTS.md + requirements.md §11):
 * - Connections are tracked per jobId in a Map.
 * - Opening a new connection for a jobId that already has one closes the old one.
 * - Connections are closed on job stop and job completion to prevent memory leaks.
 * - SSE `lead` events carry PublicLead only — _hasBoth and _qualityTier are stripped.
 * - SSE `discard` events carry updated stats.
 * - SSE `status` events carry job lifecycle changes.
 * - SSE `error` events carry non-fatal error messages.
 */

import { Response } from 'express';
import { logger } from './logger';
import {
  SseDiscardPayload,
  SseErrorPayload,
  SseEventType,
  SseLeadPayload,
  SseStatusPayload,
} from './types';

// ─── Connection Registry ──────────────────────────────────────────────────────

/**
 * Active SSE connections keyed by jobId.
 * Only one connection per jobId is allowed at any time.
 */
const activeConnections = new Map<string, Response>();

/**
 * Keepalive timers keyed by jobId.
 * Sends a comment ping every 15s to prevent proxy/load-balancer timeouts.
 */
const keepaliveTimers = new Map<string, ReturnType<typeof setInterval>>();

const KEEPALIVE_INTERVAL_MS = 15_000;

function startKeepalive(jobId: string, res: Response): void {
  stopKeepalive(jobId);
  const timer = setInterval(() => {
    if (res.writableEnded) {
      stopKeepalive(jobId);
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch {
      stopKeepalive(jobId);
    }
  }, KEEPALIVE_INTERVAL_MS);
  keepaliveTimers.set(jobId, timer);
}

function stopKeepalive(jobId: string): void {
  const timer = keepaliveTimers.get(jobId);
  if (timer) {
    clearInterval(timer);
    keepaliveTimers.delete(jobId);
  }
}

// ─── Connection Management ────────────────────────────────────────────────────

/**
 * Registers an SSE connection for a jobId.
 * If a connection already exists for this jobId, it is closed first.
 * Sets the required SSE response headers.
 */
export function registerSSEConnection(jobId: string, res: Response): void {
  // Close any existing connection for this jobId
  const existing = activeConnections.get(jobId);
  if (existing && !existing.writableEnded) {
    existing.end();
    logger.info(`SSE: closed previous connection for job ${jobId}`);
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Send an initial comment to establish the connection
  res.write(': connected\n\n');

  activeConnections.set(jobId, res);
  logger.info(`SSE: connection registered for job ${jobId}`);

  // Start keepalive heartbeat to prevent proxy timeouts
  startKeepalive(jobId, res);

  // Clean up when the client disconnects
  res.on('close', () => {
    if (activeConnections.get(jobId) === res) {
      activeConnections.delete(jobId);
      stopKeepalive(jobId);
      logger.info(`SSE: client disconnected for job ${jobId}`);
    }
  });
}

/**
 * Closes the SSE connection for a jobId and removes it from the registry.
 * Called on job stop and job completion.
 */
export function closeSSEConnection(jobId: string): void {
  const conn = activeConnections.get(jobId);
  if (conn && !conn.writableEnded) {
    conn.end();
    logger.info(`SSE: connection closed for job ${jobId}`);
  }
  activeConnections.delete(jobId);
  stopKeepalive(jobId);
}

/**
 * Returns true if there is an active SSE connection for the given jobId.
 */
export function hasSSEConnection(jobId: string): boolean {
  const conn = activeConnections.get(jobId);
  return !!conn && !conn.writableEnded;
}

// ─── Event Emitters ───────────────────────────────────────────────────────────

/**
 * Low-level SSE write helper.
 * Formats and writes a single SSE event to the response stream.
 */
function writeSSEEvent(
  res: Response,
  event: SseEventType,
  data: unknown
): void {
  if (res.writableEnded) return;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (err) {
    logger.warn(`SSE: write error — ${(err as Error).message}`);
  }
}

/**
 * Emits a `lead` event to the SSE connection for the given jobId.
 * Payload contains public lead fields only — _hasBoth and _qualityTier are excluded.
 */
export function emitLead(jobId: string, payload: SseLeadPayload): void {
  const conn = activeConnections.get(jobId);
  if (!conn) return;
  writeSSEEvent(conn, 'lead', payload);
}

/**
 * Emits a `discard` event to the SSE connection for the given jobId.
 */
export function emitDiscard(jobId: string, payload: SseDiscardPayload): void {
  const conn = activeConnections.get(jobId);
  if (!conn) return;
  writeSSEEvent(conn, 'discard', payload);
}

/**
 * Emits a `status` event to the SSE connection for the given jobId.
 */
export function emitStatus(jobId: string, payload: SseStatusPayload): void {
  const conn = activeConnections.get(jobId);
  if (!conn) return;
  writeSSEEvent(conn, 'status', payload);
}

/**
 * Emits an `error` event to the SSE connection for the given jobId.
 * Used for non-fatal errors (CAPTCHA, block, timeout).
 */
export function emitError(jobId: string, payload: SseErrorPayload): void {
  const conn = activeConnections.get(jobId);
  if (!conn) return;
  writeSSEEvent(conn, 'error', payload);
}

/**
 * Broadcasts a status event to ALL active connections.
 * Used for global state changes (e.g. server shutdown).
 */
export function broadcastStatus(payload: SseStatusPayload): void {
  for (const [, conn] of activeConnections) {
    writeSSEEvent(conn, 'status', payload);
  }
}
