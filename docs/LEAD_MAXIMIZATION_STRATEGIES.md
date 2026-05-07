# Lead Maximization Strategies

> Goal: Extract the maximum number of qualified leads (email + phone) from any industry
> and geography using the current scraper stack.
>
> Google Maps caps each individual search at ~120 results. Every strategy below is about
> working around that cap by multiplying the number of distinct queries.

---

## The Core Principle

```
Total leads = (unique queries) × (avg results per query) × (qualification rate)
                                        ↑ ~80–120                  ↑ ~40–70%
```

You cannot change the middle number — Google controls it. You can only increase the
number of unique queries. Every strategy below is a different way to do that.

---

## Strategy 1 — Keyword Multiplication (Zero effort, works today)

**How it works:** Different keyword phrasings for the same industry return different
result sets on Google Maps. "Insurance" and "insurance agent" are treated as separate
queries and surface different businesses.

**How to use it:**
Enter up to 5 keywords in the Keywords field. The scraper runs each one sequentially
and deduplicates across all runs.

**Example — Insurance industry:**
```
insurance
insurance agent
insurance broker
auto insurance
health insurance
```
5 keywords × 1 location × ~100 results = ~500 raw leads → ~200–350 qualified

**Example — Dental industry:**
```
dental clinic
dentist
orthodontist
dental implants
cosmetic dentist
```

**Yield multiplier: 3–5×**

---

## Strategy 2 — City Subdivision (Zero effort, works today)

**How it works:** A state-level search ("Ohio") returns ~120 businesses biased toward
the largest city. Searching each major city separately returns a different ~120 each time.

**How to use it:**
Enter city names as separate locations (up to 5 per job). Run multiple jobs to cover
all cities in a state.

**Ohio example — Job 1:**
```
Columbus, Cleveland, Cincinnati, Toledo, Akron
```
**Ohio example — Job 2:**
```
Dayton, Youngstown, Canton, Parma, Lorain
```

**Full state coverage plan:**
| State | Major cities | Jobs needed | Est. raw leads |
|-------|-------------|-------------|----------------|
| Ohio | 10 cities | 2 jobs | ~1,000 |
| Texas | 20 cities | 4 jobs | ~2,000 |
| California | 25 cities | 5 jobs | ~2,500 |
| New York | 15 cities | 3 jobs | ~1,500 |

**Yield multiplier: 5–20× vs state-level search**

---

## Strategy 3 — Keyword × City Matrix (Zero effort, works today)

**How it works:** Combine both strategies. 5 keywords × 5 cities = 25 sequential runs
in a single job. The dedup set prevents the same business appearing twice.

**How to use it:**
Fill both the Keywords field (5 entries) and the Locations field (5 entries).
One job runs all 25 combinations automatically.

**Example:**
```
Keywords:  insurance, insurance agent, insurance broker, auto insurance, health insurance
Locations: Columbus OH, Cleveland OH, Cincinnati OH, Toledo OH, Akron OH
```
25 runs × ~80 avg results = ~2,000 raw leads → ~800–1,400 qualified

**This is the highest-yield single-job configuration available today.**

**Yield multiplier: 15–25×**

---

## Strategy 4 — County-Level Search (Zero effort, works today)

**How it works:** US counties are smaller than states but larger than cities. Searching
by county name gives ~120 results focused on that county's businesses, including rural
areas that city searches miss.

**How to use it:**
Use county names as locations:
```
Franklin County Ohio
Cuyahoga County Ohio
Hamilton County Ohio
Montgomery County Ohio
Summit County Ohio
```

**Why this beats city search for rural coverage:**
City searches cluster around the city center. County searches surface businesses in
suburbs, small towns, and rural areas that never appear in city results.

**Ohio full coverage:**
88 counties × 1 keyword × ~80 avg results = ~7,000 raw leads → ~3,000–5,000 qualified

**Yield multiplier: 5–10× vs city search for rural industries**

---

## Strategy 5 — Neighborhood / ZIP Code Search (Zero effort, works today)

**How it works:** For dense urban markets (NYC, LA, Chicago), even city-level searches
miss thousands of businesses. ZIP code or neighborhood searches drill down further.

**How to use it:**
```
dental clinic 10001    (Manhattan ZIP)
dental clinic 10002
dental clinic 10003
dental clinic Brooklyn NY
dental clinic Queens NY
dental clinic Bronx NY
```

**When to use this:**
- Large cities where a single city search returns only downtown businesses
- Industries with very high business density (restaurants, clinics, salons)
- When you've exhausted city-level results and still need more

**Yield multiplier: 3–8× vs single city search in dense markets**

---

## Strategy 6 — Industry Synonym Expansion (Zero effort, works today)

**How it works:** The same type of business is listed under different names on Google Maps.
A dental practice might be listed as "dental clinic", "dentist", "dental office", or
"dental surgery". Each term returns a partially different result set.

**Synonym sets by industry:**

| Industry | Keywords to use |
|----------|----------------|
| Dental | dental clinic, dentist, orthodontist, dental office, oral surgeon |
| Legal | law firm, attorney, lawyer, legal services, solicitor |
| Medical | doctor, physician, medical clinic, GP, family practice |
| Real estate | real estate agent, realtor, property agent, estate agent |
| Accounting | accountant, CPA, accounting firm, tax consultant, bookkeeper |
| Insurance | insurance agent, insurance broker, insurance company, insurance office |
| Plumbing | plumber, plumbing services, plumbing contractor, drain cleaning |
| HVAC | HVAC, air conditioning, heating and cooling, AC repair, furnace repair |

**Yield multiplier: 2–4× per industry**

---

## Strategy 7 — Multi-Job Sequential Runs (Manual, works today)

**How it works:** Run multiple jobs back-to-back, each covering a different slice of
geography. Export after each job before starting the next (data is in-memory only).

**Recommended workflow for full state coverage:**

```
Job 1:  5 keywords × [Columbus, Cleveland, Cincinnati, Toledo, Akron]
Job 2:  5 keywords × [Dayton, Youngstown, Canton, Parma, Lorain]
Job 3:  5 keywords × [Springfield, Hamilton, Kettering, Elyria, Lakewood]
Job 4:  5 keywords × [Cuyahoga County, Franklin County, Hamilton County, Montgomery County, Summit County]
```

Export after each job. Combine the Excel files manually or in a spreadsheet tool.

**Important:** Cross-job deduplication is NOT automatic — the dedup set resets between
jobs. You may get some duplicates across exports. Filter by phone number in Excel to
remove them.

**Yield: Unlimited — scale by adding more jobs**

---

## Strategy 8 — Geographic Grid Search (Requires code change — future feature)

**How it works:** Instead of named places, search by GPS coordinates with a zoom level.
Google Maps accepts `@lat,lng,zoom` in the URL. At zoom 12 (city-level view), a grid
of ~20–30 coordinate points covers an entire state with no overlap.

**What it would look like:**
```
https://www.google.com/maps/search/insurance/@39.9612,-82.9988,12z  (Columbus area)
https://www.google.com/maps/search/insurance/@41.4993,-81.6944,12z  (Cleveland area)
```

**Implementation needed:**
- Add a `gridMode` option to `discovery.ts`
- Generate a lat/lng grid from a state bounding box (Nominatim returns bounding boxes)
- Run each grid point as a separate discovery query

**Yield: True exhaustive coverage — every business in a geographic area**

---

## Strategy 9 — Outscraper API Integration (Freemium — future feature)

**How it works:** Outscraper's Google Maps API returns structured data for 100 businesses
in ~5 seconds vs ~60 seconds with Playwright. The time saved per run means you can run
10× more queries in the same time window.

- Free tier: 500 records/month (~5 full runs)
- Paid: ~$3 per 1,000 records (~$0.15 per 100-lead run)

**Impact:** Same strategies above, but each run takes 5s instead of 60s. A 25-combination
job that currently takes ~25 minutes would complete in ~3 minutes.

---

## Recommended Playbook by Scale

### Getting started (100–500 leads)
1. Pick 3–5 keyword synonyms for your industry
2. Pick 1 city
3. Run one job — takes ~5 minutes

### City-level coverage (500–2,000 leads)
1. 5 keyword synonyms
2. 5 neighborhoods or ZIP codes within the city
3. Run one job — takes ~20–30 minutes

### State-level coverage (2,000–10,000 leads)
1. 5 keyword synonyms
2. Run 4–6 jobs, each covering 5 major cities
3. Export after each job
4. Combine exports in Excel, deduplicate by phone column

### National coverage (10,000+ leads)
1. 5 keyword synonyms
2. Build a list of the top 50 US cities for your industry
3. Run 10 jobs (5 cities each)
4. For dense markets, add ZIP-level jobs for NYC, LA, Chicago
5. Combine all exports

---

## Quick Reference: Expected Yields

| Configuration | Raw leads | Qualified leads | Time |
|--------------|-----------|----------------|------|
| 1 keyword × 1 city | ~80–120 | ~40–80 | ~3–5 min |
| 5 keywords × 1 city | ~300–500 | ~150–350 | ~15–25 min |
| 5 keywords × 5 cities | ~1,500–2,500 | ~600–1,500 | ~60–90 min |
| 5 keywords × 10 cities (2 jobs) | ~3,000–5,000 | ~1,200–3,000 | ~2–3 hrs |
| 5 keywords × 88 counties (18 jobs) | ~35,000 raw | ~10,000–20,000 | ~1–2 days |

Qualification rate (~40–70%) depends on industry. Industries with websites (dental,
legal, medical) qualify higher. Cash-heavy industries (food trucks, market stalls)
qualify lower.

---

## Anti-Blocking Tips for Long Runs

Running many jobs back-to-back increases CAPTCHA risk. Mitigations:

1. **Wait between jobs** — 5–10 minutes between jobs reduces detection risk
2. **Use a proxy** — Set `PROXY_URL` in `.env` for a residential IP
3. **Vary the time of day** — Avoid running large batches during peak hours
4. **Reduce delays if blocked** — If you get CAPTCHAs, increase `REQUEST_DELAY_MS` to 1000–2000
5. **Use in-depth mode sparingly** — Homepage mode is faster and less detectable for large runs

---

*The single highest-impact action: use 5 keyword synonyms + 5 cities per job.
That alone gives 15–25× more leads than a single keyword + single city search.*
