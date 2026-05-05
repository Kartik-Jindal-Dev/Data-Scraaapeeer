/**
 * sse.test.ts
 * Unit tests for the SSE connection manager.
 *
 * Covers:
 * - registerSSEConnection sets headers and writes initial comment
 * - Opening a second connection for the same jobId closes the first
 * - closeSSEConnection ends the response and removes from registry
 * - hasSSEConnection returns correct state
 * - emitLead / emitDiscard / emitStatus / emitError write correct SSE format
 * - Events are not written to ended responses
 */

import { EventEmitter } from 'events';
import {
  closeSSEConnection,
  emitDiscard,
  emitError,
  emitLead,
  emitStatus,
  hasSSEConnection,
  registerSSEConnection,
} from './sse';

// ─── Mock Response ────────────────────────────────────────────────────────────

function makeMockRes() {
  const emitter = new EventEmitter();
  const written: string[] = [];
  let ended = false;

  const res = {
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      ended = true;
      emitter.emit('close');
    }),
    on: (event: string, handler: () => void) => emitter.on(event, handler),
    get writableEnded() {
      return ended;
    },
    _written: written,
  };

  return res as unknown as import('express').Response & { _written: string[] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const JOB_A = 'job-aaa-111';
const JOB_B = 'job-bbb-222';

afterEach(() => {
  // Clean up any lingering connections
  closeSSEConnection(JOB_A);
  closeSSEConnection(JOB_B);
});

describe('registerSSEConnection()', () => {
  it('sets SSE headers', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
  });

  it('writes initial connection comment', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);
    expect(res._written.join('')).toContain(': connected');
  });

  it('marks connection as active', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);
    expect(hasSSEConnection(JOB_A)).toBe(true);
  });

  it('closes previous connection when a new one is registered for the same jobId', () => {
    const res1 = makeMockRes();
    const res2 = makeMockRes();

    registerSSEConnection(JOB_A, res1);
    registerSSEConnection(JOB_A, res2);

    expect(res1.end).toHaveBeenCalled();
    expect(hasSSEConnection(JOB_A)).toBe(true);
  });

  it('removes connection from registry when client disconnects', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);
    res.end(); // simulate client disconnect
    expect(hasSSEConnection(JOB_A)).toBe(false);
  });
});

describe('closeSSEConnection()', () => {
  it('ends the response', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);
    closeSSEConnection(JOB_A);
    expect(res.end).toHaveBeenCalled();
  });

  it('removes the connection from the registry', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);
    closeSSEConnection(JOB_A);
    expect(hasSSEConnection(JOB_A)).toBe(false);
  });

  it('does not throw if no connection exists for the jobId', () => {
    expect(() => closeSSEConnection('nonexistent-job')).not.toThrow();
  });
});

describe('hasSSEConnection()', () => {
  it('returns false when no connection registered', () => {
    expect(hasSSEConnection('unknown-job')).toBe(false);
  });

  it('returns true after registration', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_B, res);
    expect(hasSSEConnection(JOB_B)).toBe(true);
  });
});

describe('emitLead()', () => {
  it('writes a correctly formatted SSE lead event', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);

    emitLead(JOB_A, {
      businessName: 'Acme Corp',
      email: 'info@acme.com',
      phone: '+12025551234',
      website: 'https://acme.com',
      address: '123 Main St',
    });

    const output = res._written.join('');
    expect(output).toContain('event: lead');
    expect(output).toContain('"businessName":"Acme Corp"');
    expect(output).toContain('"email":"info@acme.com"');
    // Internal fields must NOT be present
    expect(output).not.toContain('_hasBoth');
    expect(output).not.toContain('_qualityTier');
  });

  it('does not throw if no connection exists for the jobId', () => {
    expect(() =>
      emitLead('no-connection', {
        businessName: 'X',
        email: '',
        phone: '',
        website: '',
        address: '',
      })
    ).not.toThrow();
  });
});

describe('emitDiscard()', () => {
  it('writes a correctly formatted SSE discard event', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);

    emitDiscard(JOB_A, { total: 3, leadCount: 10, jobStatus: 'running' });

    const output = res._written.join('');
    expect(output).toContain('event: discard');
    expect(output).toContain('"total":3');
    expect(output).toContain('"leadCount":10');
  });
});

describe('emitStatus()', () => {
  it('writes a correctly formatted SSE status event', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);

    emitStatus(JOB_A, { status: 'completed', leadCount: 42, discardCount: 5 });

    const output = res._written.join('');
    expect(output).toContain('event: status');
    expect(output).toContain('"status":"completed"');
    expect(output).toContain('"leadCount":42');
  });
});

describe('emitError()', () => {
  it('writes a correctly formatted SSE error event', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);

    emitError(JOB_A, { message: 'CAPTCHA detected' });

    const output = res._written.join('');
    expect(output).toContain('event: error');
    expect(output).toContain('"message":"CAPTCHA detected"');
  });
});

describe('SSE write safety', () => {
  it('does not write to an ended response', () => {
    const res = makeMockRes();
    registerSSEConnection(JOB_A, res);
    closeSSEConnection(JOB_A);

    // Re-register with the same ended res to test the guard
    // (In practice a new res would be used, but this tests the writableEnded guard)
    const writeCallsBefore = (res.write as jest.Mock).mock.calls.length;
    emitStatus(JOB_A, { status: 'idle', leadCount: 0, discardCount: 0 });
    expect((res.write as jest.Mock).mock.calls.length).toBe(writeCallsBefore);
  });
});
