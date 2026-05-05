/**
 * middleware/rateLimiter.ts
 * Rate limiting for POST /api/start — 5 requests per minute per IP.
 *
 * Uses express-rate-limit (in-memory store, no Redis required).
 * Applied only to /api/start to prevent accidental job spam.
 * Other endpoints are not rate-limited.
 *
 * CONSTRAINT: Does NOT break SSE or any other endpoint.
 */

import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for POST /api/start.
 * Allows 5 job-start requests per IP per 60-second window.
 */
export const startRateLimiter = rateLimit({
  windowMs: 60 * 1_000,   // 1 minute
  max: 5,                  // max 5 requests per window per IP
  standardHeaders: true,   // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,    // Disable X-RateLimit-* headers
  message: {
    error: 'rate_limit_exceeded',
    message: 'Too many job start requests. Please wait before starting another job.',
  },
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    // Use X-Forwarded-For if behind a proxy, otherwise req.ip
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.ip ?? 'unknown';
  },
});
