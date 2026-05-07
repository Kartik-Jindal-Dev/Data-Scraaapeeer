/**
 * pipeline/stateScheduler.test.ts
 * Unit tests for the dynamic round-robin city scheduler.
 *
 * Test coverage (Phase 3):
 * - One selection
 * - Many selections
 * - Uneven selection sizes
 * - Visited-heavy skipping
 * - Fully exhausted selections
 * - Partially exhausted selections
 * - Sequential rounds
 * - Stable ordering
 * - Stop-safe iteration
 */

import { createStateScheduler } from './stateScheduler';
import type { CityEntry } from '../types';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/** Creates a mock city entry for testing. */
function mockCity(name: string, state: string, country = 'US'): CityEntry {
  return {
    name,
    state,
    country,
    importance: 0.5,
    source: 'static',
  };
}

/** Creates an array of mock cities with sequential names. */
function mockCities(state: string, count: number, prefix = 'City'): CityEntry[] {
  return Array.from({ length: count }, (_, i) => mockCity(`${prefix}${i + 1}`, state));
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('stateScheduler', () => {
  describe('createStateScheduler — validation', () => {
    it('should throw when batchSize < 1', () => {
      expect(() =>
        createStateScheduler({
          selections: [{ name: 'TX', rankedCities: mockCities('TX', 10) }],
          batchSize: 0,
          isVisited: () => false,
        })
      ).toThrow('batchSize must be >= 1');
    });

    it('should throw when selections array is empty', () => {
      expect(() =>
        createStateScheduler({
          selections: [],
          batchSize: 5,
          isVisited: () => false,
        })
      ).toThrow('selections array must not be empty');
    });

    it('should accept a selection with 0 cities (immediately exhausted)', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'Empty', rankedCities: [] }],
        batchSize: 5,
        isVisited: () => false,
      });
      const round = scheduler.nextRound();
      expect(round.cities).toEqual([]);
      expect(round.allExhausted).toBe(true);
    });
  });

  describe('one selection', () => {
    it('should produce one round with all cities when count <= batchSize', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: mockCities('TX', 3) }],
        batchSize: 5,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.roundNumber).toBe(1);
      expect(round1.cities).toHaveLength(3);
      expect(round1.cities.map((c) => c.city.name)).toEqual(['City1', 'City2', 'City3']);
      expect(round1.allExhausted).toBe(true);
      expect(round1.newlyExhausted).toEqual(['TX']);

      const round2 = scheduler.nextRound();
      expect(round2.roundNumber).toBe(2);
      expect(round2.cities).toEqual([]);
      expect(round2.allExhausted).toBe(true);
    });

    it('should produce multiple rounds when count > batchSize', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: mockCities('TX', 12) }],
        batchSize: 5,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.roundNumber).toBe(1);
      expect(round1.cities).toHaveLength(5);
      expect(round1.cities.map((c) => c.city.name)).toEqual(['City1', 'City2', 'City3', 'City4', 'City5']);
      expect(round1.allExhausted).toBe(false);

      const round2 = scheduler.nextRound();
      expect(round2.roundNumber).toBe(2);
      expect(round2.cities).toHaveLength(5);
      expect(round2.cities.map((c) => c.city.name)).toEqual(['City6', 'City7', 'City8', 'City9', 'City10']);
      expect(round2.allExhausted).toBe(false);

      const round3 = scheduler.nextRound();
      expect(round3.roundNumber).toBe(3);
      expect(round3.cities).toHaveLength(2);
      expect(round3.cities.map((c) => c.city.name)).toEqual(['City11', 'City12']);
      expect(round3.allExhausted).toBe(true);
      expect(round3.newlyExhausted).toEqual(['TX']);
    });
  });

  describe('many selections', () => {
    it('should interleave cities from multiple selections in selection order', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'TX', rankedCities: mockCities('TX', 6, 'TX') },
          { name: 'CA', rankedCities: mockCities('CA', 6, 'CA') },
          { name: 'NY', rankedCities: mockCities('NY', 6, 'NY') },
        ],
        batchSize: 2,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities).toHaveLength(6); // 2 from each selection
      expect(round1.cities.map((c) => c.city.name)).toEqual([
        'TX1', 'TX2', // TX first
        'CA1', 'CA2', // CA second
        'NY1', 'NY2', // NY third
      ]);
      expect(round1.cities.map((c) => c.selectionName)).toEqual(['TX', 'TX', 'CA', 'CA', 'NY', 'NY']);

      const round2 = scheduler.nextRound();
      expect(round2.cities).toHaveLength(6);
      expect(round2.cities.map((c) => c.city.name)).toEqual(['TX3', 'TX4', 'CA3', 'CA4', 'NY3', 'NY4']);

      const round3 = scheduler.nextRound();
      expect(round3.cities).toHaveLength(6);
      expect(round3.cities.map((c) => c.city.name)).toEqual(['TX5', 'TX6', 'CA5', 'CA6', 'NY5', 'NY6']);
      expect(round3.allExhausted).toBe(true);
    });

    it('should preserve selection order (not alphabetical)', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'Zebra', rankedCities: mockCities('Zebra', 2, 'Z') },
          { name: 'Apple', rankedCities: mockCities('Apple', 2, 'A') },
          { name: 'Mango', rankedCities: mockCities('Mango', 2, 'M') },
        ],
        batchSize: 1,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities.map((c) => c.selectionName)).toEqual(['Zebra', 'Apple', 'Mango']);
      expect(round1.cities.map((c) => c.city.name)).toEqual(['Z1', 'A1', 'M1']);
    });
  });

  describe('uneven selection sizes', () => {
    it('should handle selections with different city counts', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'Small', rankedCities: mockCities('Small', 2, 'S') },
          { name: 'Large', rankedCities: mockCities('Large', 10, 'L') },
        ],
        batchSize: 3,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities).toHaveLength(5); // 2 from Small, 3 from Large
      expect(round1.cities.map((c) => c.city.name)).toEqual(['S1', 'S2', 'L1', 'L2', 'L3']);
      expect(round1.newlyExhausted).toEqual(['Small']);
      expect(round1.allExhausted).toBe(false);

      const round2 = scheduler.nextRound();
      expect(round2.cities).toHaveLength(3); // 0 from Small (exhausted), 3 from Large
      expect(round2.cities.map((c) => c.city.name)).toEqual(['L4', 'L5', 'L6']);
      expect(round2.newlyExhausted).toEqual([]);
      expect(round2.allExhausted).toBe(false);

      const round3 = scheduler.nextRound();
      expect(round3.cities).toHaveLength(3);
      expect(round3.cities.map((c) => c.city.name)).toEqual(['L7', 'L8', 'L9']);

      const round4 = scheduler.nextRound();
      expect(round4.cities).toHaveLength(1); // Last city from Large
      expect(round4.cities.map((c) => c.city.name)).toEqual(['L10']);
      expect(round4.newlyExhausted).toEqual(['Large']);
      expect(round4.allExhausted).toBe(true);
    });

    it('should skip exhausted selections in subsequent rounds', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'A', rankedCities: mockCities('A', 1, 'A') },
          { name: 'B', rankedCities: mockCities('B', 5, 'B') },
          { name: 'C', rankedCities: mockCities('C', 2, 'C') },
        ],
        batchSize: 2,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities.map((c) => c.city.name)).toEqual(['A1', 'B1', 'B2', 'C1', 'C2']);
      expect(round1.newlyExhausted).toEqual(['A', 'C']);

      const round2 = scheduler.nextRound();
      expect(round2.cities.map((c) => c.city.name)).toEqual(['B3', 'B4']); // Only B remains
      expect(round2.newlyExhausted).toEqual([]);

      const round3 = scheduler.nextRound();
      expect(round3.cities.map((c) => c.city.name)).toEqual(['B5']);
      expect(round3.newlyExhausted).toEqual(['B']);
      expect(round3.allExhausted).toBe(true);
    });
  });

  describe('visited-city skipping (lazy)', () => {
    it('should skip visited cities and advance cursor until batchSize valid cities found', () => {
      const cities = mockCities('TX', 10);
      const visitedSet = new Set(['City2', 'City3', 'City5', 'City7']);

      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: cities }],
        batchSize: 3,
        isVisited: (city) => visitedSet.has(city.name),
      });

      const round1 = scheduler.nextRound();
      // Should collect City1, skip City2/City3, collect City4, skip City5, collect City6
      expect(round1.cities.map((c) => c.city.name)).toEqual(['City1', 'City4', 'City6']);
      expect(round1.allExhausted).toBe(false);

      const round2 = scheduler.nextRound();
      // Should skip City7, collect City8, City9, City10
      expect(round2.cities.map((c) => c.city.name)).toEqual(['City8', 'City9', 'City10']);
      expect(round2.allExhausted).toBe(true);
    });

    it('should handle all cities visited (exhausts immediately)', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: mockCities('TX', 5) }],
        batchSize: 3,
        isVisited: () => true, // All visited
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities).toEqual([]);
      expect(round1.allExhausted).toBe(true);
      expect(round1.newlyExhausted).toEqual(['TX']);
    });

    it('should handle visited cities across multiple selections', () => {
      const visitedSet = new Set(['TX2', 'CA1', 'CA3', 'NY1', 'NY2']);

      const scheduler = createStateScheduler({
        selections: [
          { name: 'TX', rankedCities: mockCities('TX', 4, 'TX') },
          { name: 'CA', rankedCities: mockCities('CA', 4, 'CA') },
          { name: 'NY', rankedCities: mockCities('NY', 4, 'NY') },
        ],
        batchSize: 2,
        isVisited: (city) => visitedSet.has(city.name),
      });

      const round1 = scheduler.nextRound();
      // TX: collect TX1, skip TX2, collect TX3 (2 valid)
      // CA: skip CA1, collect CA2, skip CA3, collect CA4 (2 valid)
      // NY: skip NY1, skip NY2, collect NY3, NY4 (2 valid)
      expect(round1.cities.map((c) => c.city.name)).toEqual(['TX1', 'TX3', 'CA2', 'CA4', 'NY3', 'NY4']);
      expect(round1.allExhausted).toBe(false);

      const round2 = scheduler.nextRound();
      // TX: collect TX4 (1 valid, then exhausted)
      // CA: exhausted
      // NY: exhausted
      expect(round2.cities.map((c) => c.city.name)).toEqual(['TX4']);
      expect(round2.allExhausted).toBe(true);
    });
  });

  describe('fully exhausted selections', () => {
    it('should mark selection exhausted when cursor reaches end', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: mockCities('TX', 3) }],
        batchSize: 5,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.allExhausted).toBe(true);
      expect(round1.newlyExhausted).toEqual(['TX']);
      expect(round1.allExhaustedSelections).toEqual(['TX']);

      const snapshot = scheduler.snapshot();
      expect(snapshot.allExhausted).toBe(true);
      expect(snapshot.selections[0].exhausted).toBe(true);
      expect(snapshot.selections[0].cursor).toBe(3);
      expect(snapshot.selections[0].citiesYielded).toBe(3);
    });

    it('should return empty rounds after all selections exhausted', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'A', rankedCities: mockCities('A', 2) },
          { name: 'B', rankedCities: mockCities('B', 2) },
        ],
        batchSize: 5,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.allExhausted).toBe(true);

      const round2 = scheduler.nextRound();
      expect(round2.cities).toEqual([]);
      expect(round2.allExhausted).toBe(true);
      expect(round2.roundNumber).toBe(2);

      const round3 = scheduler.nextRound();
      expect(round3.cities).toEqual([]);
      expect(round3.allExhausted).toBe(true);
      expect(round3.roundNumber).toBe(3);
    });
  });

  describe('partially exhausted selections', () => {
    it('should track which selections are exhausted vs active', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'Small', rankedCities: mockCities('Small', 2) },
          { name: 'Medium', rankedCities: mockCities('Medium', 5) },
          { name: 'Large', rankedCities: mockCities('Large', 10) },
        ],
        batchSize: 3,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.newlyExhausted).toEqual(['Small']);
      expect(round1.allExhaustedSelections).toEqual(['Small']);

      const round2 = scheduler.nextRound();
      expect(round2.newlyExhausted).toEqual(['Medium']);
      expect(round2.allExhaustedSelections).toEqual(['Small', 'Medium']);

      const round3 = scheduler.nextRound();
      expect(round3.newlyExhausted).toEqual([]);
      expect(round3.allExhaustedSelections).toEqual(['Small', 'Medium']);

      const round4 = scheduler.nextRound();
      expect(round4.newlyExhausted).toEqual(['Large']);
      expect(round4.allExhaustedSelections).toEqual(['Small', 'Medium', 'Large']);
      expect(round4.allExhausted).toBe(true);
    });
  });

  describe('sequential rounds', () => {
    it('should increment roundNumber on every call', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: mockCities('TX', 10) }],
        batchSize: 3,
        isVisited: () => false,
      });

      expect(scheduler.nextRound().roundNumber).toBe(1);
      expect(scheduler.nextRound().roundNumber).toBe(2);
      expect(scheduler.nextRound().roundNumber).toBe(3);
      expect(scheduler.nextRound().roundNumber).toBe(4);
      expect(scheduler.nextRound().roundNumber).toBe(5); // Empty round after exhaustion
    });

    it('should never produce overlapping cities across rounds', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: mockCities('TX', 10) }],
        batchSize: 3,
        isVisited: () => false,
      });

      const allCities = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const round = scheduler.nextRound();
        for (const { city } of round.cities) {
          expect(allCities.has(city.name)).toBe(false); // No duplicates
          allCities.add(city.name);
        }
      }
      expect(allCities.size).toBe(10);
    });
  });

  describe('stable ordering', () => {
    it('should maintain city order within each selection', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: mockCities('TX', 10) }],
        batchSize: 3,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities.map((c) => c.city.name)).toEqual(['City1', 'City2', 'City3']);

      const round2 = scheduler.nextRound();
      expect(round2.cities.map((c) => c.city.name)).toEqual(['City4', 'City5', 'City6']);
    });

    it('should maintain selection order across rounds', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'First', rankedCities: mockCities('First', 6, 'F') },
          { name: 'Second', rankedCities: mockCities('Second', 6, 'S') },
          { name: 'Third', rankedCities: mockCities('Third', 6, 'T') },
        ],
        batchSize: 2,
        isVisited: () => false,
      });

      for (let i = 0; i < 3; i++) {
        const round = scheduler.nextRound();
        const selectionOrder = round.cities.map((c) => c.selectionName);
        expect(selectionOrder).toEqual(['First', 'First', 'Second', 'Second', 'Third', 'Third']);
      }
    });
  });

  describe('stop-safe iteration', () => {
    it('should allow controller to break loop at any round', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: mockCities('TX', 20) }],
        batchSize: 5,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities).toHaveLength(5);

      // Controller decides to stop here (e.g., maxLeads reached)
      // Scheduler state is preserved — can resume if needed
      const snapshot = scheduler.snapshot();
      expect(snapshot.currentRound).toBe(1);
      expect(snapshot.selections[0].cursor).toBe(5);
      expect(snapshot.selections[0].citiesYielded).toBe(5);

      // If controller resumes later
      const round2 = scheduler.nextRound();
      expect(round2.cities).toHaveLength(5);
      expect(round2.cities.map((c) => c.city.name)).toEqual(['City6', 'City7', 'City8', 'City9', 'City10']);
    });
  });

  describe('snapshot()', () => {
    it('should return current state without advancing', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'TX', rankedCities: mockCities('TX', 10) },
          { name: 'CA', rankedCities: mockCities('CA', 5) },
        ],
        batchSize: 3,
        isVisited: () => false,
      });

      const snap1 = scheduler.snapshot();
      expect(snap1.currentRound).toBe(0);
      expect(snap1.allExhausted).toBe(false);
      expect(snap1.selections).toHaveLength(2);
      expect(snap1.selections[0].cursor).toBe(0);
      expect(snap1.selections[0].citiesYielded).toBe(0);

      scheduler.nextRound();

      const snap2 = scheduler.snapshot();
      expect(snap2.currentRound).toBe(1);
      expect(snap2.selections[0].cursor).toBe(3);
      expect(snap2.selections[0].citiesYielded).toBe(3);
      expect(snap2.selections[1].cursor).toBe(3);
      expect(snap2.selections[1].citiesYielded).toBe(3);

      scheduler.nextRound();

      const snap3 = scheduler.snapshot();
      expect(snap3.currentRound).toBe(2);
      expect(snap3.selections[0].cursor).toBe(6);
      expect(snap3.selections[1].exhausted).toBe(true);
    });
  });

  describe('reset()', () => {
    it('should reset all cursors and round counter', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: mockCities('TX', 10) }],
        batchSize: 3,
        isVisited: () => false,
      });

      scheduler.nextRound();
      scheduler.nextRound();

      const snapBefore = scheduler.snapshot();
      expect(snapBefore.currentRound).toBe(2);
      expect(snapBefore.selections[0].cursor).toBe(6);

      scheduler.reset();

      const snapAfter = scheduler.snapshot();
      expect(snapAfter.currentRound).toBe(0);
      expect(snapAfter.selections[0].cursor).toBe(0);
      expect(snapAfter.selections[0].citiesYielded).toBe(0);
      expect(snapAfter.selections[0].exhausted).toBe(false);

      const round1 = scheduler.nextRound();
      expect(round1.roundNumber).toBe(1);
      expect(round1.cities.map((c) => c.city.name)).toEqual(['City1', 'City2', 'City3']);
    });
  });

  describe('selectionIndex annotation', () => {
    it('should annotate each city with its 0-based selection index', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'First', rankedCities: mockCities('First', 2, 'F') },
          { name: 'Second', rankedCities: mockCities('Second', 2, 'S') },
          { name: 'Third', rankedCities: mockCities('Third', 2, 'T') },
        ],
        batchSize: 1,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities[0].selectionIndex).toBe(0); // First
      expect(round1.cities[1].selectionIndex).toBe(1); // Second
      expect(round1.cities[2].selectionIndex).toBe(2); // Third
    });
  });

  describe('edge cases', () => {
    it('should handle batchSize larger than all cities combined', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'A', rankedCities: mockCities('A', 2) },
          { name: 'B', rankedCities: mockCities('B', 3) },
        ],
        batchSize: 100,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities).toHaveLength(5);
      expect(round1.allExhausted).toBe(true);
    });

    it('should handle batchSize = 1', () => {
      const scheduler = createStateScheduler({
        selections: [
          { name: 'A', rankedCities: mockCities('A', 3) },
          { name: 'B', rankedCities: mockCities('B', 3) },
        ],
        batchSize: 1,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities).toHaveLength(2); // 1 from A, 1 from B
      expect(round1.cities.map((c) => c.city.name)).toEqual(['City1', 'City1']);
      expect(round1.cities.map((c) => c.city.state)).toEqual(['A', 'B']);
    });

    it('should handle single city in single selection', () => {
      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: mockCities('TX', 1) }],
        batchSize: 5,
        isVisited: () => false,
      });

      const round1 = scheduler.nextRound();
      expect(round1.cities).toHaveLength(1);
      expect(round1.allExhausted).toBe(true);
    });

    it('should handle visited cities causing early exhaustion', () => {
      const cities = mockCities('TX', 5);
      const visitedSet = new Set(['City3', 'City4', 'City5']);

      const scheduler = createStateScheduler({
        selections: [{ name: 'TX', rankedCities: cities }],
        batchSize: 3,
        isVisited: (city) => visitedSet.has(city.name),
      });

      const round1 = scheduler.nextRound();
      // Should collect City1, City2, then exhaust (remaining are visited)
      expect(round1.cities.map((c) => c.city.name)).toEqual(['City1', 'City2']);
      expect(round1.allExhausted).toBe(true);
    });
  });
});
