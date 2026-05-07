/**
 * routes/locations.ts
 * GET /api/locations/countries  — list all countries (name + isoCode)
 * GET /api/locations/states     — list states for a country (?country=ISO)
 *
 * Backed by country-state-city package (static, no network calls).
 * Used by the frontend dropdowns to populate country and state selectors.
 */

import { Request, Response, Router } from 'express';
import { getCountries, getStates } from '../pipeline/cityPool';

export const locationsRouter = Router();

// GET /api/locations/countries
locationsRouter.get('/countries', (_req: Request, res: Response) => {
  const countries = getCountries();
  res.json(countries); // [{ name, isoCode }, ...]
});

// GET /api/locations/states?country=IN
locationsRouter.get('/states', (req: Request, res: Response) => {
  const country = req.query.country as string | undefined;
  if (!country || country.trim().length === 0) {
    res.status(400).json({ error: 'country query param is required' });
    return;
  }
  const states = getStates(country.trim());
  res.json(states); // [{ name, isoCode, countryCode }, ...]
});
