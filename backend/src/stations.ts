/**
 * stations.ts
 * ---------------------------------------------------------------------------
 * The full AbhiBus station master (routes/routes.json, ~22,600 rows) loaded
 * once into an in-memory index, so `resolveCityIds` can turn any city name a
 * user types into the numeric id `searchBuses` demands — instantly, without a
 * round trip to the browser tab and without the model ever seeing the 10 MB
 * file itself.
 *
 * Matching strategy, cheapest first:
 *   1. exact normalised name  ("pune"        -> Pune, 51)
 *   2. exact short name       ("hyd"         -> Hyderabad, 3)
 *   3. alias table            ("bombay"      -> Mumbai, 4)
 *   4. prefix match           ("vishakha"    -> Visakhapatnam)
 *   5. substring match        ("majestic"    -> Bangalore (Majestic))
 * Ties are broken by: active status, lower tier (1 = metro), shorter name,
 * lower station key — which reliably surfaces "Pune" above "Pune(Aundh)".
 * ---------------------------------------------------------------------------
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Station {
  id: number;
  name: string;
  shortName: string;
  state: string;
  tier: number;
  active: boolean;
}

export interface StationMatch extends Station {
  /** How the match was found — useful in logs and for the model's confidence. */
  via: 'exact' | 'short' | 'alias' | 'prefix' | 'substring';
}

export interface ResolveOutcome {
  query: string;
  match: StationMatch | null;
  /** Close runners-up so the model can ask "did you mean…?". */
  alternatives: StationMatch[];
}

/* ------------------------------------------------------------------------ */

/** Old / colloquial names people actually type. Values are normalised names. */
const ALIASES: Record<string, string> = {
  bombay: 'mumbai',
  bangalore: 'bengaluru',
  bengaluru: 'bangalore', // whichever spelling the master uses, find the other
  banglore: 'bangalore',
  calcutta: 'kolkata',
  madras: 'chennai',
  vizag: 'visakhapatnam',
  trivandrum: 'thiruvananthapuram',
  pondicherry: 'puducherry',
  pondy: 'puducherry',
  gurgaon: 'gurugram',
  benares: 'varanasi',
  panjim: 'goa',
  panaji: 'goa',
};

function normalise(name: unknown): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------------ */

let stations: Station[] | null = null;
let byName: Map<string, Station[]> | null = null;
let byShort: Map<string, Station[]> | null = null;

function stationsFilePath(): string {
  const override = process.env.STATIONS_FILE?.trim();
  if (override && existsSync(override)) return override;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'routes/routes.json'), // running from src/ via tsx
    join(here, '../src/routes/routes.json'), // running from dist/ via node
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Station master not found. Looked in: ${candidates.join(', ')}. ` +
      'Set STATIONS_FILE to the path of routes.json.',
  );
}

/** Parse and index the station master. Called once, lazily or from boot. */
export function loadStations(): Station[] {
  if (stations) return stations;

  const raw = JSON.parse(readFileSync(stationsFilePath(), 'utf8')) as {
    abrs_stations?: Array<Record<string, unknown>>;
  };
  const rows = Array.isArray(raw.abrs_stations) ? raw.abrs_stations : [];

  stations = [];
  byName = new Map();
  byShort = new Map();

  for (const row of rows) {
    const id = Number(row.Station_Key);
    const name = String(row.Station_Name ?? '').trim();
    if (!Number.isFinite(id) || !name) continue;

    const station: Station = {
      id,
      name,
      shortName: String(row.Station_Short_Name ?? '').trim(),
      state: String(row.State_Name ?? '').trim(),
      tier: Number(row.tier) || 99,
      active: row.Status === 'A',
    };
    stations.push(station);

    const nameKey = normalise(station.name);
    if (nameKey) {
      const bucket = byName.get(nameKey);
      if (bucket) bucket.push(station);
      else byName.set(nameKey, [station]);
    }

    const shortKey = normalise(station.shortName);
    if (shortKey && shortKey !== nameKey) {
      const bucket = byShort.get(shortKey);
      if (bucket) bucket.push(station);
      else byShort.set(shortKey, [station]);
    }
  }

  return stations;
}

export function stationCount(): number {
  return loadStations().length;
}

/* ------------------------------------------------------------------------ */

/** Active first, metro tier first, plain name over "(suburb)", lowest key. */
function rank(a: Station, b: Station): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  return a.id - b.id;
}

function best(list: Station[] | undefined, via: StationMatch['via']): StationMatch[] {
  if (!list?.length) return [];
  return [...list].sort(rank).map((s) => ({ ...s, via }));
}

/**
 * Resolve one free-text city name against the master.
 * Never throws; an unresolvable name comes back as `{ match: null }`.
 */
export function resolveStation(query: string): ResolveOutcome {
  loadStations();
  const key = normalise(query);
  if (!key) return { query, match: null, alternatives: [] };

  const found: StationMatch[] = [];
  const seen = new Set<number>();
  const take = (matches: StationMatch[]) => {
    for (const m of matches) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        found.push(m);
      }
    }
  };

  take(best(byName!.get(key), 'exact'));
  take(best(byShort!.get(key), 'short'));

  const alias = ALIASES[key];
  if (alias) take(best(byName!.get(alias), 'alias'));

  // Prefix / substring passes only when nothing exact matched — a full scan of
  // 22k rows is ~1 ms, cheap enough to do per request.
  if (found.length === 0) {
    const prefix: Station[] = [];
    const substring: Station[] = [];
    for (const station of stations!) {
      const name = normalise(station.name);
      if (name.startsWith(key)) prefix.push(station);
      else if (key.length >= 4 && name.includes(key)) substring.push(station);
    }
    take(best(prefix, 'prefix'));
    take(best(substring, 'substring'));
  }

  return {
    query,
    match: found[0] ?? null,
    alternatives: found.slice(1, 5),
  };
}
