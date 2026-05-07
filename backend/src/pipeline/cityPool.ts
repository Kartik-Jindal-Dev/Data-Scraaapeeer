/**
 * pipeline/cityPool.ts
 * Phase 12 — Location Engine (Revised): Static Global City Pool
 *
 * Data sources (both static, no network calls, no TTL):
 *   1. country-state-city npm package — countries, states, ISO codes
 *   2. GeoNames cities15000.txt       — city population for ranking
 *   3. GeoNames admin1CodesASCII.txt  — maps GeoNames admin1 numeric codes
 *                                       to state names (for population lookup)
 *
 * Architecture:
 *   - Module-level Maps built once at startup from the two static sources.
 *   - No Nominatim calls. No HTTP. No cache TTL. No bootstrap fallback.
 *   - country-state-city provides the authoritative country/state/city list.
 *   - GeoNames population is joined in to rank cities largest-first.
 *   - Cities with no GeoNames population entry are ranked last (population = 0).
 *
 * Key functions:
 *   getCountries()                    — all 250 countries with ISO codes
 *   getStates(countryIso)             — states/regions for a country
 *   buildCityPool(countryIso, state)  — ranked city pool for one state
 *   buildMultiStateCityPool(iso, [])  — concatenated pools across states
 *   resolveCountryIso(nameOrCode)     — full name → ISO code
 *
 * CONSTRAINTS:
 * - No pipeline.ts changes.
 * - No new external dependencies beyond country-state-city (already installed).
 * - CityEntry / CityPool types unchanged.
 * - Batching compatibility preserved.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Country, State, City } from 'country-state-city';
import { logger } from '../logger';
import { CityEntry, CityPool } from '../types';

// ─── Config ───────────────────────────────────────────────────────────────────

const CITIES_PER_STATE = parseInt(process.env.CITIES_PER_STATE ?? '20', 10);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StateEntry {
  name: string;
  isoCode: string;
  countryCode: string;
}

export interface CountryEntry {
  name: string;
  isoCode: string;
}

// ─── GeoNames Population Map ──────────────────────────────────────────────────

/**
 * Maps `${countryIso}:${cityNameLower}` → population.
 * Built once at module load from cities15000.txt.
 * Used to rank cities by population descending.
 */
const geoPopMap = new Map<string, number>();

/**
 * Maps `${countryIso}:${admin1NumericCode}` → state name (lowercase).
 * Built from admin1CodesASCII.txt.
 * Used to join GeoNames admin1 numeric codes to state names.
 */
const admin1NameMap = new Map<string, string>();

/**
 * Phase 5 fix — Region bridge:
 * Maps `${countryIso}:${admin1Code}` → the country-state-city state isoCode
 * that has cities and best matches the GeoNames admin1 region name.
 *
 * Built lazily per country on first use (not at startup) to avoid the
 * ~20s startup cost of scanning all countries.
 */
const geoAdmin1ToRegionIso = new Map<string, string>();

/** Tracks which countries have already had their bridge built. */
const bridgeBuiltForCountry = new Set<string>();

function loadGeoNamesData(): void {
  const dataDir = path.join(__dirname, '..', '..', 'data');

  // ── Load admin1 codes ─────────────────────────────────────────────────────
  const admin1Path = path.join(dataDir, 'admin1CodesASCII.txt');
  if (fs.existsSync(admin1Path)) {
    const lines = fs.readFileSync(admin1Path, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const cols = line.split('\t');
      if (cols.length < 2) continue;
      // Format: "IN.28\tWest Bengal\t..."
      const [countryDotAdmin, name] = [cols[0], cols[1]];
      const dotIdx = countryDotAdmin.indexOf('.');
      if (dotIdx === -1) continue;
      const countryIso = countryDotAdmin.slice(0, dotIdx).toUpperCase();
      const admin1Code = countryDotAdmin.slice(dotIdx + 1);
      admin1NameMap.set(`${countryIso}:${admin1Code}`, name.toLowerCase().trim());
    }
    logger.info(`CityPool: loaded ${admin1NameMap.size} admin1 code mappings`);
  } else {
    logger.warn(`CityPool: admin1CodesASCII.txt not found at ${admin1Path} — population ranking disabled`);
  }

  // ── Load cities15000 ──────────────────────────────────────────────────────
  const citiesPath = path.join(dataDir, 'cities15000.txt');
  if (fs.existsSync(citiesPath)) {
    const lines = fs.readFileSync(citiesPath, 'utf8').split('\n').filter(Boolean);
    let loaded = 0;
    for (const line of lines) {
      const cols = line.split('\t');
      if (cols.length < 15) continue;
      const cityName = cols[1]?.trim();
      const countryIso = cols[8]?.trim().toUpperCase();
      const admin1Code = cols[10]?.trim();
      const population = parseInt(cols[14] ?? '0', 10);
      if (!cityName || !countryIso || isNaN(population)) continue;

      // Key by country + city name (lowercase) for direct lookup
      const directKey = `${countryIso}:${cityName.toLowerCase()}`;
      const existing = geoPopMap.get(directKey) ?? 0;
      if (population > existing) {
        geoPopMap.set(directKey, population);
      }

      // Also key by country + admin1 state name + city name for state-scoped lookup
      const stateName = admin1NameMap.get(`${countryIso}:${admin1Code}`);
      if (stateName) {
        const stateKey = `${countryIso}:${stateName}:${cityName.toLowerCase()}`;
        const existingState = geoPopMap.get(stateKey) ?? 0;
        if (population > existingState) {
          geoPopMap.set(stateKey, population);
        }
      }
      loaded++;
    }
    logger.info(`CityPool: loaded ${loaded} GeoNames city population entries`);
  } else {
    logger.warn(`CityPool: cities15000.txt not found at ${citiesPath} — cities will not be ranked by population`);
  }
}

// Load at module startup (synchronous, runs once)
loadGeoNamesData();

// ─── Population Lookup ────────────────────────────────────────────────────────

/**
 * Returns the population for a city, using state-scoped lookup first
 * (more accurate for cities with duplicate names across states),
 * then country-scoped fallback.
 */
function getCityPopulation(countryIso: string, stateName: string, cityName: string): number {
  const iso = countryIso.toUpperCase();
  const stateKey = `${iso}:${stateName.toLowerCase()}:${cityName.toLowerCase()}`;
  const stateHit = geoPopMap.get(stateKey);
  if (stateHit !== undefined) return stateHit;

  const countryKey = `${iso}:${cityName.toLowerCase()}`;
  return geoPopMap.get(countryKey) ?? 0;
}

// ─── Country Name → ISO Resolution ───────────────────────────────────────────

/** Module-level map: lowercase country name → ISO code. Built once. */
const countryNameToIso = new Map<string, string>();
(function buildCountryNameMap() {
  for (const c of Country.getAllCountries()) {
    countryNameToIso.set(c.name.toLowerCase(), c.isoCode.toUpperCase());
    countryNameToIso.set(c.isoCode.toLowerCase(), c.isoCode.toUpperCase());
  }
})();

/**
 * Resolves a country string (full name or ISO code) to an ISO 3166-1 alpha-2 code.
 * Returns the input uppercased if no match found (pass-through for already-valid codes).
 */
export function resolveCountryIso(nameOrCode: string): string {
  const lower = nameOrCode.trim().toLowerCase();
  return countryNameToIso.get(lower) ?? nameOrCode.trim().toUpperCase();
}

// ─── State Name Fuzzy Match ───────────────────────────────────────────────────

/**
 * Finds the best matching state for a user-supplied state name.
 * Tries exact match first, then case-insensitive, then prefix match.
 * Returns the matched state or null.
 */
function findState(countryIso: string, stateName: string) {
  const states = State.getStatesOfCountry(countryIso);
  if (!states.length) return null;

  const lower = stateName.trim().toLowerCase();

  // Exact case-insensitive match
  const exact = states.find((s) => s.name.toLowerCase() === lower);
  if (exact) return exact;

  // Prefix match (e.g. "uttrak" → "Uttarakhand")
  const prefix = states.find((s) => s.name.toLowerCase().startsWith(lower));
  if (prefix) return prefix;

  // Substring match (e.g. "tamil" → "Tamil Nadu")
  const sub = states.find(
    (s) => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase())
  );
  if (sub) return sub;

  // Fuzzy: input starts with first 5 chars of state name (handles typos like "uttrak" → "uttarakhand")
  if (lower.length >= 4) {
    const fuzzy = states.find((s) => {
      const sLower = s.name.toLowerCase().replace(/\s+/g, '');
      const inputClean = lower.replace(/\s+/g, '');
      // Check if first 5 chars of either match
      return sLower.startsWith(inputClean.slice(0, 5)) || inputClean.startsWith(sLower.slice(0, 5));
    });
    if (fuzzy) return fuzzy;
  }

  return null;
}

// ─── Region Bridge Helper ─────────────────────────────────────────────────────

/**
 * Lazily builds the GeoNames admin1 → region bridge for a single country.
 * Called on first use of that country — not at startup.
 *
 * Matches each GeoNames admin1 name to the country-state-city state with cities
 * that has the most similar name. Stores results in geoAdmin1ToRegionIso.
 */
function buildBridgeForCountry(countryIso: string): void {
  if (bridgeBuiltForCountry.has(countryIso)) return;
  bridgeBuiltForCountry.add(countryIso);

  const statesWithCities = State.getStatesOfCountry(countryIso).filter(
    (s) => City.getCitiesOfState(countryIso, s.isoCode).length > 0
  );
  if (statesWithCities.length === 0) return;

  // For each GeoNames admin1 entry for this country, find the best matching region
  for (const [key, geoName] of admin1NameMap) {
    if (!key.startsWith(`${countryIso}:`)) continue;
    const admin1Code = key.slice(countryIso.length + 1);
    const geoLower = geoName.replace(/[^a-z0-9]/g, '');

    let bestIso: string | null = null;
    let bestScore = 0;

    for (const state of statesWithCities) {
      const stateLower = state.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      let score = 0;

      if (stateLower === geoLower) {
        score = 100;
      } else if (stateLower.includes(geoLower) || geoLower.includes(stateLower)) {
        score = 60;
      } else {
        let shared = 0;
        const minLen = Math.min(stateLower.length, geoLower.length);
        for (let i = 0; i < minLen; i++) {
          if (stateLower[i] === geoLower[i]) shared++;
          else break;
        }
        if (shared >= 4) score = shared * 10;
      }

      if (score > bestScore) {
        bestScore = score;
        bestIso = state.isoCode;
      }
    }

    if (bestIso && bestScore >= 40) {
      geoAdmin1ToRegionIso.set(`${countryIso}:${admin1Code}`, bestIso);
    }
  }
}

/**
 * When a matched state has 0 cities, finds the parent region that has cities.
 *
 * Strategy (in order):
 * 1. GeoNames bridge: match the state name to a GeoNames admin1 entry, then
 *    look up the bridge to find the correct region-with-cities.
 * 2. Name similarity: find the state-with-cities whose name most closely matches.
 * 3. City-name fallback: if the input looks like a city name, find the region
 *    that contains a city with that name.
 *
 * Returns the isoCode of the best matching region-with-cities, or null.
 */
function findRegionWithCities(countryIso: string, matchedStateName: string, originalInput: string): string | null {
  // Ensure bridge is built for this country (lazy, cached)
  buildBridgeForCountry(countryIso);

  const statesWithCities = State.getStatesOfCountry(countryIso).filter(
    (s) => City.getCitiesOfState(countryIso, s.isoCode).length > 0
  );
  if (statesWithCities.length === 0) return null;

  // Strategy 1: GeoNames bridge — find admin1 code for the matched state name
  const matchedLower = matchedStateName.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [key, geoName] of admin1NameMap) {
    if (!key.startsWith(`${countryIso}:`)) continue;
    const geoNorm = geoName.replace(/[^a-z0-9]/g, '');
    if (
      geoNorm === matchedLower ||
      (matchedLower.length >= 5 && geoNorm.startsWith(matchedLower.slice(0, 5))) ||
      (geoNorm.length >= 5 && matchedLower.startsWith(geoNorm.slice(0, 5)))
    ) {
      const admin1Code = key.slice(countryIso.length + 1);
      const bridgedIso = geoAdmin1ToRegionIso.get(`${countryIso}:${admin1Code}`);
      if (bridgedIso) return bridgedIso;
    }
  }

  // Strategy 2: name similarity against states-with-cities
  const inputLower = originalInput.toLowerCase().replace(/[^a-z0-9]/g, '');
  let bestIso: string | null = null;
  let bestScore = 0;

  for (const state of statesWithCities) {
    const stateLower = state.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    let score = 0;

    if (stateLower === inputLower || stateLower === matchedLower) {
      score = 100;
    } else {
      // Only apply substring/prefix checks when lengths are reasonably similar
      // (ratio >= 0.5) to avoid "barcelona".includes("lon") matching Léon
      const longer = Math.max(stateLower.length, inputLower.length);
      const shorter = Math.min(stateLower.length, inputLower.length);
      const lengthRatio = shorter / longer;

      if (lengthRatio >= 0.5) {
        if (stateLower.includes(inputLower) || inputLower.includes(stateLower)) {
          score = 60;
        } else if (stateLower.includes(matchedLower) || matchedLower.includes(stateLower)) {
          score = 55;
        }
      }

      if (score === 0) {
        // Shared prefix (length-independent)
        let shared = 0;
        const minLen = Math.min(stateLower.length, inputLower.length);
        for (let i = 0; i < minLen; i++) {
          if (stateLower[i] === inputLower[i]) shared++;
          else break;
        }
        if (shared >= 4) score = shared * 8;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIso = state.isoCode;
    }
  }

  if (bestScore >= 40 && bestIso) return bestIso;

  // Strategy 3: city-name fallback — input may be a city name.
  // Pick the region containing the highest-population city with that name
  // to avoid matching small towns before major cities.
  const cityInputLower = originalInput.toLowerCase();
  let bestCityRegionIso: string | null = null;
  let bestCityPop = -1;

  for (const state of statesWithCities) {
    const cities = City.getCitiesOfState(countryIso, state.isoCode);
    const match = cities.find(
      (c) => c.name.toLowerCase() === cityInputLower || c.name.toLowerCase().startsWith(cityInputLower)
    );
    if (match) {
      const pop = geoPopMap.get(`${countryIso}:${match.name.toLowerCase()}`) ?? 0;
      if (pop > bestCityPop) {
        bestCityPop = pop;
        bestCityRegionIso = state.isoCode;
      }
    }
  }

  if (bestCityRegionIso) return bestCityRegionIso;

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns all 250 countries with name and ISO code. */
export function getCountries(): CountryEntry[] {
  return Country.getAllCountries().map((c) => ({
    name: c.name,
    isoCode: c.isoCode,
  }));
}

/**
 * Returns all states/regions for a country.
 * Only returns states that have cities in the package — filters out
 * sub-regions/departments that have 0 cities to prevent empty city pools.
 * @param countryIso  ISO 3166-1 alpha-2 code or full country name
 */
export function getStates(countryIso: string): StateEntry[] {
  const iso = resolveCountryIso(countryIso);
  const allStates = State.getStatesOfCountry(iso);

  // Filter to states that actually have cities — avoids showing departments
  // that are listed in the package but have no city data (e.g. FR departments
  // vs FR regions, IT provinces vs IT regions, GB counties vs GB nations).
  const statesWithCities = allStates.filter(
    (s) => City.getCitiesOfState(iso, s.isoCode).length > 0
  );

  // If filtering leaves nothing (e.g. very small country), return all states
  const result = statesWithCities.length > 0 ? statesWithCities : allStates;

  return result.map((s) => ({
    name: s.name,
    isoCode: s.isoCode,
    countryCode: s.countryCode,
  }));
}

/**
 * Builds a city pool for a given country + state/region.
 *
 * Cities come from country-state-city package (authoritative list).
 * Population from GeoNames is used to rank cities largest-first.
 * Cities with no GeoNames entry are appended at the end (population = 0).
 * Pool is capped at CITIES_PER_STATE (default 20).
 *
 * @param countryIso  ISO 3166-1 alpha-2 code or full country name
 * @param stateName   State/region name (fuzzy matched)
 */
export async function buildCityPool(countryIso: string, stateName: string): Promise<CityPool> {
  const iso = resolveCountryIso(countryIso);

  // Fuzzy-match the state name to handle typos / partial names
  const matchedState = findState(iso, stateName);
  if (!matchedState) {
    logger.warn(`CityPool: no state match for "${stateName}" in country="${iso}" — returning empty pool`);
    return { state: stateName, cities: [], fetchedAt: Date.now() };
  }

  const resolvedStateName = matchedState.name;
  const stateIsoCode = matchedState.isoCode;

  logger.info(
    `CityPool: building pool — country="${iso}" state="${resolvedStateName}" (matched from "${stateName}") target=${CITIES_PER_STATE}`
  );

  // Get cities from country-state-city
  const rawCities = City.getCitiesOfState(iso, stateIsoCode);

  if (rawCities.length === 0) {
    logger.warn(`CityPool: no cities found for country="${iso}" state="${resolvedStateName}"`);
    return { state: resolvedStateName, cities: [], fetchedAt: Date.now() };
  }

  // Attach population from GeoNames and sort descending
  const ranked = rawCities
    .map((c) => ({
      name: c.name,
      population: getCityPopulation(iso, resolvedStateName, c.name),
      lat: c.latitude ? parseFloat(c.latitude) : undefined,
      lon: c.longitude ? parseFloat(c.longitude) : undefined,
    }))
    .sort((a, b) => b.population - a.population);

  const cities: CityEntry[] = ranked.slice(0, CITIES_PER_STATE).map((c) => ({
    name: c.name,
    state: resolvedStateName,
    country: iso,
    lat: c.lat,
    lon: c.lon,
    importance: c.population > 0 ? c.population / 10_000_000 : undefined,
    source: 'static' as const,
  }));

  logger.info(
    `CityPool: pool ready — country="${iso}" state="${resolvedStateName}" — ${cities.length} cities (top: ${cities[0]?.name ?? 'none'})`
  );

  return { state: resolvedStateName, cities, fetchedAt: Date.now() };
}

/**
 * Returns the FULL ranked city list for a state (no cap).
 * Used by the auto-expansion controller to paginate through city tiers.
 *
 * @param countryIso  ISO 3166-1 alpha-2 code
 * @param stateName   State/region name (fuzzy matched)
 * @returns All cities sorted by population descending, or [] if state not found
 */
export function getFullRankedCities(countryIso: string, stateName: string): CityEntry[] {
  const iso = resolveCountryIso(countryIso);
  let matchedState = findState(iso, stateName);

  if (!matchedState) {
    // findState found nothing — try the region bridge directly with the raw input.
    // Handles city names (e.g. "Barcelona" → Catalonia) and alternate spellings.
    const bridgedIso = findRegionWithCities(iso, stateName, stateName);
    if (bridgedIso) {
      const bridgedState = State.getStatesOfCountry(iso).find(s => s.isoCode === bridgedIso);
      if (bridgedState) {
        logger.info(
          `CityPool: "${stateName}" not found as state — resolved to region "${bridgedState.name}" (${iso})`
        );
        matchedState = bridgedState;
      }
    }
    if (!matchedState) return [];
  }

  // ── Region bridge: if matched state has 0 cities, find the parent region ──
  // This handles countries where city data is stored under top-level regions
  // but the package also lists sub-regions/departments as states (e.g. France,
  // Italy, Spain, UK). We use the GeoNames admin1 bridge built at startup to
  // find the correct region.
  if (City.getCitiesOfState(iso, matchedState.isoCode).length === 0) {
    const bridgedIso = findRegionWithCities(iso, matchedState.name, stateName);
    if (bridgedIso) {
      const bridgedState = State.getStatesOfCountry(iso).find(s => s.isoCode === bridgedIso);
      if (bridgedState) {
        logger.info(
          `CityPool: "${stateName}" (${matchedState.name}) has no cities — ` +
          `resolved to parent region "${bridgedState.name}" (${iso})`
        );
        matchedState = bridgedState;
      }
    }
  }

  const resolvedStateName = matchedState.name;
  const stateIsoCode = matchedState.isoCode;
  const rawCities = City.getCitiesOfState(iso, stateIsoCode);
  if (rawCities.length === 0) return [];

  return rawCities
    .map((c) => ({
      name: c.name,
      population: getCityPopulation(iso, resolvedStateName, c.name),
      lat: c.latitude ? parseFloat(c.latitude) : undefined,
      lon: c.longitude ? parseFloat(c.longitude) : undefined,
    }))
    .sort((a, b) => b.population - a.population)
    .map((c) => ({
      name: c.name,
      state: resolvedStateName,
      country: iso,
      lat: c.lat,
      lon: c.lon,
      importance: c.population > 0 ? c.population / 10_000_000 : undefined,
      source: 'static' as const,
    }));
}

/**
 * Builds city pools for multiple states within a country and concatenates them.
 * States are processed in input order; within each state, largest cities first.
 *
 * @param countryIso  ISO 3166-1 alpha-2 code or full country name
 * @param stateNames  Array of state/region names (fuzzy matched)
 */
export async function buildMultiStateCityPool(
  countryIso: string,
  stateNames: string[]
): Promise<CityEntry[]> {
  const iso = resolveCountryIso(countryIso);
  const allCities: CityEntry[] = [];

  for (const stateName of stateNames) {
    const pool = await buildCityPool(iso, stateName);
    allCities.push(...pool.cities);
  }

  logger.info(
    `CityPool: multi-state pool — country="${iso}" ${stateNames.length} state(s), ${allCities.length} total cities`
  );
  return allCities;
}
