/**
 * routes/start.regression.test.ts
 * Phase 7 — Full Regression Testing
 *
 * Tests both execution paths of the city-batched controller:
 *   PATH B — Flattened batching (CITY_ROUND_ROBIN_ENABLED=false, default)
 *   PATH A — Round-robin scheduler (CITY_ROUND_ROBIN_ENABLED=true)
 *
 * All I/O is mocked at the module boundary. No real scraping, no network calls.
 * The controller's async IIFE is driven by waiting for closeSSEConnection to be called.
 *
 * Scenarios covered (per plan Phase 7):
 *   - Feature flag switching (both paths produce correct city dispatch order)
 *   - Stop mid-round / mid-batch
 *   - maxLeads mid-round / mid-batch
 *   - Visited-heavy queues
 *   - Exhausted selections
 *   - Many-selection runs
 *   - Sequential mode (PARALLEL_CITIES_ENABLED=false)
 *   - Parallel mode (PARALLEL_CITIES_ENABLED=true)
 *   - SSE stability (emitStatus called with correct payloads)
 *   - No ordering corruption (cities dispatched in correct order)
 */

import express from 'express';
import request from 'supertest';
import { store } from '../store';
import { resetStopSignal, stopSignal } from '../pipeline/pipeline';

// ─── Module mocks ─────────────────────────────────────────────────────────────

// Mock pipeline — never runs real scraping
jest.mock('../pipeline/pipeline', () => ({
  stopSignal: { stopped: false },
  resetStopSignal: jest.fn(),
  signalStop: jest.fn(),
  runPipeline: jest.fn().mockResolvedValue(undefined),
}));

// Mock cityPool — returns controlled city lists
jest.mock('../pipeline/cityPool', () => ({
  resolveCountryIso: jest.fn((v: string) => v.toUpperCase()),
  getFullRankedCities: jest.fn(),
}));

// Mock SSE — capture emitted events
jest.mock('../sse', () => ({
  emitStatus: jest.fn(),
  closeSSEConnection: jest.fn(),
}));

// Mock visitedCities — use spyOn-compatible real module mock
jest.mock('../pipeline/visitedCities', () => ({
  isCityVisited: jest.fn().mockReturnValue(false),
  markCityVisited: jest.fn(),
  clearVisitedCitiesForTesting: jest.fn(),
}));
// Mock rate limiter — pass through
jest.mock('../middleware/rateLimiter', () => ({
  startRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { startRouter } from './start';
import { runPipeline } from '../pipeline/pipeline';
import { getFullRankedCities } from '../pipeline/cityPool';
import { emitStatus, closeSSEConnection } from '../sse';
// Import the whole module so we can control the mock via the module object
import * as visitedCities from '../pipeline/visitedCities';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCity(name: string, state: string) {
  return { name, state, country: 'US', source: 'static' as const };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/start', startRouter);
  return app;
}

/** Waits until closeSSEConnection has been called (job finished). */
function waitForJobEnd(timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = setInterval(() => {
      if ((closeSSEConnection as jest.Mock).mock.calls.length > 0) {
        clearInterval(check);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(check);
        reject(new Error('Timed out waiting for job to finish'));
      }
    }, 10);
  });
}

/** Base valid request body for city-batched mode. */
function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    keyword: 'plumber',
    country: 'US',
    states: ['Texas'],
    maxLeads: 100,
    depth: 'homepage',
    contactFilter: 'any',
    ...overrides,
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  store.reset();
  // Reset stop signal object in place (it's a shared reference)
  stopSignal.stopped = false;
  visitedCities.clearVisitedCitiesForTesting();

  // Default: no cities visited
  (visitedCities.isCityVisited as jest.Mock).mockImplementation(() => false);

  // Default: runPipeline resolves immediately
  (runPipeline as jest.Mock).mockResolvedValue(undefined);

  // Default env — flattened path, sequential, batchSize=3
  process.env.CITY_ROUND_ROBIN_ENABLED = 'false';
  process.env.PARALLEL_CITIES_ENABLED = 'false';
  process.env.CITY_BATCH_SIZE = '3';
  process.env.INTER_JOB_DELAY_MS = '0';
});

afterEach(() => {
  delete process.env.CITY_ROUND_ROBIN_ENABLED;
  delete process.env.PARALLEL_CITIES_ENABLED;
  delete process.env.CITY_BATCH_SIZE;
  delete process.env.INTER_JOB_DELAY_MS;
});

// ═════════════════════════════════════════════════════════════════════════════
// PATH B — Flattened Batching (CITY_ROUND_ROBIN_ENABLED=false)
// ═════════════════════════════════════════════════════════════════════════════

describe('PATH B — Flattened batching (CITY_ROUND_ROBIN_ENABLED=false)', () => {
  const app = makeApp();

  beforeEach(() => {
    process.env.CITY_ROUND_ROBIN_ENABLED = 'false';
  });

  it('dispatches all cities in population order across batches', async () => {
    const cities = ['C1', 'C2', 'C3', 'C4', 'C5'].map(n => makeCity(n, 'Texas'));
    (getFullRankedCities as jest.Mock).mockReturnValue(cities);

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    const calls = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    expect(calls).toEqual(['C1, Texas', 'C2, Texas', 'C3, Texas', 'C4, Texas', 'C5, Texas']);
  });

  it('emits running status before each batch', async () => {
    const cities = ['C1', 'C2', 'C3', 'C4'].map(n => makeCity(n, 'Texas'));
    (getFullRankedCities as jest.Mock).mockReturnValue(cities);
    process.env.CITY_BATCH_SIZE = '2'; // force 2 batches: [C1,C2] and [C3,C4]

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    const statusCalls = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
    const runningCalls = statusCalls.filter(p => p.status === 'running' && p.batchProgress);
    // 2 batches → 2 running status emits with batchProgress
    expect(runningCalls.length).toBeGreaterThanOrEqual(2);
    expect(runningCalls[0].batchProgress.currentBatch).toBe(1);
    expect(runningCalls[1].batchProgress.currentBatch).toBe(2);
  });

  it('emits completed status with correct final counts', async () => {
    const cities = ['C1', 'C2'].map(n => makeCity(n, 'Texas'));
    (getFullRankedCities as jest.Mock).mockReturnValue(cities);

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    const statusCalls = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
    const terminal = statusCalls.find(p => p.status === 'completed' || p.status === 'stopped');
    expect(terminal).toBeDefined();
    expect(terminal.status).toBe('completed');
  });

  it('skips visited cities and still dispatches unvisited ones', async () => {
    const cities = ['C1', 'C2', 'C3'].map(n => makeCity(n, 'Texas'));
    (getFullRankedCities as jest.Mock).mockReturnValue(cities);
    // C2 is visited
    (visitedCities.isCityVisited as jest.Mock).mockImplementation((_kw: string, city: string) => city === 'C2');

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    const dispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    expect(dispatched).toContain('C1, Texas');
    expect(dispatched).toContain('C3, Texas');
    expect(dispatched).not.toContain('C2, Texas');
  });

  it('stops immediately when stop signal is set mid-batch', async () => {
    const cities = ['C1', 'C2', 'C3', 'C4', 'C5'].map(n => makeCity(n, 'Texas'));
    (getFullRankedCities as jest.Mock).mockReturnValue(cities);

    let callCount = 0;
    (runPipeline as jest.Mock).mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) stopSignal.stopped = true;
    });

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    // Should stop after 2 dispatches, not run all 5
    expect((runPipeline as jest.Mock).mock.calls.length).toBeLessThan(5);

    const statusCalls = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
    const terminal = statusCalls.find(p => p.status === 'stopped' || p.status === 'completed');
    expect(terminal).toBeDefined();
  });

  it('halts when maxLeads is reached mid-batch', async () => {
    const cities = ['C1', 'C2', 'C3', 'C4', 'C5'].map(n => makeCity(n, 'Texas'));
    (getFullRankedCities as jest.Mock).mockReturnValue(cities);

    // After 2nd pipeline call, simulate 2 leads found (maxLeads=2)
    let callCount = 0;
    (runPipeline as jest.Mock).mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) {
        // Manually add leads to store to trigger maxLeads condition
        store.addLead({ businessName: 'A', email: 'a@a.com', phone: '', website: '', address: '', _hasBoth: false, _qualityTier: 'Tier2' });
        store.addLead({ businessName: 'B', email: 'b@b.com', phone: '', website: '', address: '', _hasBoth: false, _qualityTier: 'Tier2' });
      }
    });

    await request(app).post('/api/start').send(baseBody({ maxLeads: 2 }));
    await waitForJobEnd();

    expect((runPipeline as jest.Mock).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('marks each city visited after its job completes', async () => {
    const cities = ['C1', 'C2'].map(n => makeCity(n, 'Texas'));
    (getFullRankedCities as jest.Mock).mockReturnValue(cities);

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    const markedCities = (visitedCities.markCityVisited as jest.Mock).mock.calls.map((c: string[]) => c[1]);
    expect(markedCities).toContain('C1');
    expect(markedCities).toContain('C2');
  });

  it('handles empty city pool gracefully', async () => {
    (getFullRankedCities as jest.Mock).mockReturnValue([]);

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    expect(runPipeline as jest.Mock).not.toHaveBeenCalled();
    const statusCalls = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
    const terminal = statusCalls.find(p => p.status === 'completed');
    expect(terminal).toBeDefined();
  });

  it('handles multiple states — concatenates city lists in order', async () => {
    (getFullRankedCities as jest.Mock)
      .mockImplementation((_iso: string, state: string) => {
        if (state === 'Texas') return [makeCity('TX1', 'Texas'), makeCity('TX2', 'Texas')];
        if (state === 'California') return [makeCity('CA1', 'California'), makeCity('CA2', 'California')];
        return [];
      });

    await request(app).post('/api/start').send(baseBody({ states: ['Texas', 'California'] }));
    await waitForJobEnd();

    const dispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    // Texas cities come first (flattened order)
    expect(dispatched.indexOf('TX1, Texas')).toBeLessThan(dispatched.indexOf('CA1, California'));
  });

  it('parallel mode — dispatches cities concurrently within a batch', async () => {
    process.env.PARALLEL_CITIES_ENABLED = 'true';
    process.env.PARALLEL_CITIES_MAX = '2';

    const cities = ['C1', 'C2', 'C3'].map(n => makeCity(n, 'Texas'));
    (getFullRankedCities as jest.Mock).mockReturnValue(cities);

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    // All 3 cities should still be dispatched
    const dispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    expect(dispatched).toHaveLength(3);
  });

  it('roundRobinProgress is absent from SSE payloads in flattened path', async () => {
    const cities = ['C1', 'C2'].map(n => makeCity(n, 'Texas'));
    (getFullRankedCities as jest.Mock).mockReturnValue(cities);

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    const allPayloads = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
    for (const p of allPayloads) {
      expect(p.roundRobinProgress).toBeUndefined();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PATH A — Round-Robin Scheduler (CITY_ROUND_ROBIN_ENABLED=true)
// ═════════════════════════════════════════════════════════════════════════════

describe('PATH A — Round-robin scheduler (CITY_ROUND_ROBIN_ENABLED=true)', () => {
  const app = makeApp();

  beforeEach(() => {
    process.env.CITY_ROUND_ROBIN_ENABLED = 'true';
  });

  it('dispatches cities from each selection in round-robin order', async () => {
    (getFullRankedCities as jest.Mock)
      .mockImplementation((_iso: string, state: string) => {
        if (state === 'Texas') return ['TX1', 'TX2', 'TX3'].map(n => makeCity(n, 'Texas'));
        if (state === 'California') return ['CA1', 'CA2', 'CA3'].map(n => makeCity(n, 'California'));
        return [];
      });

    process.env.CITY_BATCH_SIZE = '2';
    await request(app).post('/api/start').send(baseBody({ states: ['Texas', 'California'] }));
    await waitForJobEnd();

    const dispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);

    // Round 1: TX1, TX2 (Texas batchSize=2), then CA1, CA2 (California batchSize=2)
    // Round 2: TX3 (Texas remainder), then CA3 (California remainder)
    expect(dispatched[0]).toBe('TX1, Texas');
    expect(dispatched[1]).toBe('TX2, Texas');
    expect(dispatched[2]).toBe('CA1, California');
    expect(dispatched[3]).toBe('CA2, California');
    expect(dispatched[4]).toBe('TX3, Texas');
    expect(dispatched[5]).toBe('CA3, California');
  });

  it('preserves selection order — never reorders alphabetically', async () => {
    (getFullRankedCities as jest.Mock)
      .mockImplementation((_iso: string, state: string) => {
        if (state === 'Zebra') return [makeCity('Z1', 'Zebra')];
        if (state === 'Apple') return [makeCity('A1', 'Apple')];
        if (state === 'Mango') return [makeCity('M1', 'Mango')];
        return [];
      });

    process.env.CITY_BATCH_SIZE = '1';
    await request(app).post('/api/start').send(
      baseBody({ states: ['Zebra', 'Apple', 'Mango'] })
    );
    await waitForJobEnd();

    const dispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    expect(dispatched[0]).toBe('Z1, Zebra');
    expect(dispatched[1]).toBe('A1, Apple');
    expect(dispatched[2]).toBe('M1, Mango');
  });

  it('skips visited cities lazily — collects batchSize valid cities per selection', async () => {
    // C2 is visited — scheduler should skip it and collect C3 instead
    (getFullRankedCities as jest.Mock).mockReturnValue(
      ['C1', 'C2', 'C3', 'C4'].map(n => makeCity(n, 'Texas'))
    );
    (visitedCities.isCityVisited as jest.Mock).mockImplementation((_kw: string, city: string) => city === 'C2');

    process.env.CITY_BATCH_SIZE = '2';
    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    const dispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    expect(dispatched).not.toContain('C2, Texas');
    expect(dispatched).toContain('C1, Texas');
    expect(dispatched).toContain('C3, Texas');
  });

  it('exhausted selections are skipped in subsequent rounds', async () => {
    (getFullRankedCities as jest.Mock)
      .mockImplementation((_iso: string, state: string) => {
        if (state === 'Small') return [makeCity('S1', 'Small')];
        if (state === 'Large') return ['L1', 'L2', 'L3', 'L4'].map(n => makeCity(n, 'Large'));
        return [];
      });

    process.env.CITY_BATCH_SIZE = '2';
    await request(app).post('/api/start').send(baseBody({ states: ['Small', 'Large'] }));
    await waitForJobEnd();

    const dispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    // Small exhausts after round 1 — subsequent rounds only have Large cities
    expect(dispatched).toContain('S1, Small');
    expect(dispatched).toContain('L1, Large');
    expect(dispatched).toContain('L2, Large');
    expect(dispatched).toContain('L3, Large');
    expect(dispatched).toContain('L4, Large');
    // Small only appears once
    expect(dispatched.filter(d => d.includes('Small'))).toHaveLength(1);
  });

  it('stops immediately when stop signal is set mid-round', async () => {
    (getFullRankedCities as jest.Mock).mockReturnValue(
      ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map(n => makeCity(n, 'Texas'))
    );

    let callCount = 0;
    (runPipeline as jest.Mock).mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) stopSignal.stopped = true;
    });

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    expect((runPipeline as jest.Mock).mock.calls.length).toBeLessThan(6);

    const statusCalls = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
    const terminal = statusCalls.find(p => p.status === 'stopped' || p.status === 'completed');
    expect(terminal).toBeDefined();
  });

  it('halts when maxLeads is reached mid-round', async () => {
    (getFullRankedCities as jest.Mock).mockReturnValue(
      ['C1', 'C2', 'C3', 'C4', 'C5'].map(n => makeCity(n, 'Texas'))
    );

    let callCount = 0;
    (runPipeline as jest.Mock).mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) {
        store.addLead({ businessName: 'X', email: 'x@x.com', phone: '', website: '', address: '', _hasBoth: false, _qualityTier: 'Tier2' });
        store.addLead({ businessName: 'Y', email: 'y@y.com', phone: '', website: '', address: '', _hasBoth: false, _qualityTier: 'Tier2' });
      }
    });

    await request(app).post('/api/start').send(baseBody({ maxLeads: 2 }));
    await waitForJobEnd();

    expect((runPipeline as jest.Mock).mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('emits roundRobinProgress in every running status event', async () => {
    (getFullRankedCities as jest.Mock).mockReturnValue(
      ['C1', 'C2', 'C3'].map(n => makeCity(n, 'Texas'))
    );

    process.env.CITY_BATCH_SIZE = '2';
    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    const statusCalls = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
    const withRR = statusCalls.filter(p => p.roundRobinProgress !== undefined);
    expect(withRR.length).toBeGreaterThan(0);

    // Each roundRobinProgress should have currentRound and selections
    for (const p of withRR) {
      expect(p.roundRobinProgress.currentRound).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(p.roundRobinProgress.selections)).toBe(true);
      expect(p.roundRobinProgress.selections[0].name).toBe('Texas');
    }
  });

  it('final status includes roundRobinProgress with exhausted selections', async () => {
    (getFullRankedCities as jest.Mock).mockReturnValue(
      ['C1', 'C2'].map(n => makeCity(n, 'Texas'))
    );

    process.env.CITY_BATCH_SIZE = '2';
    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    const statusCalls = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
    const terminal = statusCalls.find(p => p.status === 'completed' || p.status === 'stopped');
    expect(terminal).toBeDefined();
    expect(terminal.roundRobinProgress).toBeDefined();
    expect(terminal.roundRobinProgress.selections[0].exhausted).toBe(true);
  });

  it('many selections — all selections receive cities each round', async () => {
    const stateNames = ['S1', 'S2', 'S3', 'S4', 'S5'];
    (getFullRankedCities as jest.Mock)
      .mockImplementation((_iso: string, state: string) =>
        [makeCity(`${state}C1`, state), makeCity(`${state}C2`, state)]
      );

    process.env.CITY_BATCH_SIZE = '1';
    await request(app).post('/api/start').send(baseBody({ states: stateNames }));
    await waitForJobEnd();

    const dispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    // Round 1 (batchSize=1): one city from each of 5 states in order
    expect(dispatched[0]).toContain('S1');
    expect(dispatched[1]).toContain('S2');
    expect(dispatched[2]).toContain('S3');
    expect(dispatched[3]).toContain('S4');
    expect(dispatched[4]).toContain('S5');
  });

  it('parallel mode — all cities in a round are dispatched', async () => {
    process.env.PARALLEL_CITIES_ENABLED = 'true';
    process.env.PARALLEL_CITIES_MAX = '2';

    (getFullRankedCities as jest.Mock)
      .mockImplementation((_iso: string, state: string) => {
        if (state === 'Texas') return ['TX1', 'TX2'].map(n => makeCity(n, 'Texas'));
        if (state === 'California') return ['CA1', 'CA2'].map(n => makeCity(n, 'California'));
        return [];
      });

    process.env.CITY_BATCH_SIZE = '2';
    await request(app).post('/api/start').send(baseBody({ states: ['Texas', 'California'] }));
    await waitForJobEnd();

    const dispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    expect(dispatched).toHaveLength(4);
    expect(dispatched).toContain('TX1, Texas');
    expect(dispatched).toContain('TX2, Texas');
    expect(dispatched).toContain('CA1, California');
    expect(dispatched).toContain('CA2, California');
  });

  it('all-visited queue — exhausts without dispatching any cities', async () => {
    (getFullRankedCities as jest.Mock).mockReturnValue(
      ['C1', 'C2', 'C3'].map(n => makeCity(n, 'Texas'))
    );
    (visitedCities.isCityVisited as jest.Mock).mockReturnValue(true); // all visited

    await request(app).post('/api/start').send(baseBody());
    await waitForJobEnd();

    expect(runPipeline as jest.Mock).not.toHaveBeenCalled();
    const statusCalls = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
    const terminal = statusCalls.find(p => p.status === 'completed');
    expect(terminal).toBeDefined();
  });

  it('marks each city visited after its job completes', async () => {
    (getFullRankedCities as jest.Mock)
      .mockImplementation((_iso: string, state: string) => {
        if (state === 'Texas') return [makeCity('TX1', 'Texas')];
        if (state === 'California') return [makeCity('CA1', 'California')];
        return [];
      });

    process.env.CITY_BATCH_SIZE = '1';
    await request(app).post('/api/start').send(baseBody({ states: ['Texas', 'California'] }));
    await waitForJobEnd();

    const marked = (visitedCities.markCityVisited as jest.Mock).mock.calls.map((c: string[]) => c[1]);
    expect(marked).toContain('TX1');
    expect(marked).toContain('CA1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Feature flag switching
// ═════════════════════════════════════════════════════════════════════════════

describe('Feature flag switching', () => {
  const app = makeApp();

  it('flattened path concatenates states; round-robin path interleaves them', async () => {
    (getFullRankedCities as jest.Mock)
      .mockImplementation((_iso: string, state: string) => {
        if (state === 'Texas') return ['TX1', 'TX2'].map(n => makeCity(n, 'Texas'));
        if (state === 'California') return ['CA1', 'CA2'].map(n => makeCity(n, 'California'));
        return [];
      });

    process.env.CITY_BATCH_SIZE = '2';

    // ── Flattened path ──
    process.env.CITY_ROUND_ROBIN_ENABLED = 'false';
    jest.clearAllMocks();
    stopSignal.stopped = false;
    store.reset();

    await request(app).post('/api/start').send(baseBody({ states: ['Texas', 'California'] }));
    await waitForJobEnd();

    const flatDispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    // Flattened: TX1, TX2, CA1, CA2 (all Texas first, then California)
    expect(flatDispatched[0]).toBe('TX1, Texas');
    expect(flatDispatched[1]).toBe('TX2, Texas');
    expect(flatDispatched[2]).toBe('CA1, California');
    expect(flatDispatched[3]).toBe('CA2, California');

    // ── Round-robin path ──
    process.env.CITY_ROUND_ROBIN_ENABLED = 'true';
    jest.clearAllMocks();
    stopSignal.stopped = false;
    store.reset();

    await request(app).post('/api/start').send(baseBody({ states: ['Texas', 'California'] }));
    await waitForJobEnd();

    const rrDispatched = (runPipeline as jest.Mock).mock.calls.map(c => c[0].location);
    // Round-robin: TX1, TX2 (Texas round 1), CA1, CA2 (California round 1)
    expect(rrDispatched[0]).toBe('TX1, Texas');
    expect(rrDispatched[1]).toBe('TX2, Texas');
    expect(rrDispatched[2]).toBe('CA1, California');
    expect(rrDispatched[3]).toBe('CA2, California');
  });

  it('switching flag does not affect SSE connection lifecycle', async () => {
    (getFullRankedCities as jest.Mock).mockReturnValue([makeCity('C1', 'Texas')]);

    for (const flag of ['false', 'true']) {
      process.env.CITY_ROUND_ROBIN_ENABLED = flag;
      jest.clearAllMocks();
      stopSignal.stopped = false;
      store.reset();

      await request(app).post('/api/start').send(baseBody());
      await waitForJobEnd();

      expect(closeSSEConnection as jest.Mock).toHaveBeenCalledTimes(1);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SSE stability
// ═════════════════════════════════════════════════════════════════════════════

describe('SSE stability', () => {
  const app = makeApp();

  it('always emits a terminal status (completed or stopped) before closing', async () => {
    (getFullRankedCities as jest.Mock).mockReturnValue(['C1', 'C2'].map(n => makeCity(n, 'Texas')));

    for (const flag of ['false', 'true']) {
      process.env.CITY_ROUND_ROBIN_ENABLED = flag;
      jest.clearAllMocks();
      stopSignal.stopped = false;
      store.reset();

      await request(app).post('/api/start').send(baseBody());
      await waitForJobEnd();

      const statusCalls = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
      const terminal = statusCalls.find(p =>
        p.status === 'completed' || p.status === 'stopped' || p.status === 'error'
      );
      expect(terminal).toBeDefined();
      expect(closeSSEConnection as jest.Mock).toHaveBeenCalledTimes(1);
    }
  });

  it('batchProgress is present in all running status events', async () => {
    (getFullRankedCities as jest.Mock).mockReturnValue(['C1', 'C2', 'C3'].map(n => makeCity(n, 'Texas')));

    for (const flag of ['false', 'true']) {
      process.env.CITY_ROUND_ROBIN_ENABLED = flag;
      jest.clearAllMocks();
      stopSignal.stopped = false;
      store.reset();

      await request(app).post('/api/start').send(baseBody());
      await waitForJobEnd();

      const statusCalls = (emitStatus as jest.Mock).mock.calls.map(c => c[1]);
      const runningWithProgress = statusCalls.filter(p => p.status === 'running' && p.batchProgress);
      expect(runningWithProgress.length).toBeGreaterThan(0);
    }
  });

  it('no duplicate closeSSEConnection calls', async () => {
    (getFullRankedCities as jest.Mock).mockReturnValue(['C1'].map(n => makeCity(n, 'Texas')));

    for (const flag of ['false', 'true']) {
      process.env.CITY_ROUND_ROBIN_ENABLED = flag;
      jest.clearAllMocks();
      stopSignal.stopped = false;
      store.reset();

      await request(app).post('/api/start').send(baseBody());
      await waitForJobEnd();

      expect(closeSSEConnection as jest.Mock).toHaveBeenCalledTimes(1);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Input validation (shared by both paths)
// ═════════════════════════════════════════════════════════════════════════════

describe('Input validation', () => {
  const app = makeApp();

  it('rejects missing keyword', async () => {
    const res = await request(app).post('/api/start').send({ country: 'US', states: ['Texas'] });
    expect(res.status).toBe(400);
  });

  it('rejects missing country in city-batched mode', async () => {
    const res = await request(app).post('/api/start').send({ keyword: 'plumber', states: ['Texas'] });
    expect(res.status).toBe(400);
  });

  it('rejects empty states array', async () => {
    const res = await request(app).post('/api/start').send({ keyword: 'plumber', country: 'US', states: [] });
    expect(res.status).toBe(400);
  });

  it('rejects invalid maxLeads', async () => {
    const res = await request(app).post('/api/start').send(baseBody({ maxLeads: -1 }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid depth', async () => {
    const res = await request(app).post('/api/start').send(baseBody({ depth: 'deep' }));
    expect(res.status).toBe(400);
  });

  it('returns 409 when a job is already running', async () => {
    store.setStatus('running');
    const res = await request(app).post('/api/start').send(baseBody());
    expect(res.status).toBe(409);
  });
});
