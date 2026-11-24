import {
  CATEGORIES,
  ROUTE_COLORS,
  type Category,
  type LatLng,
  type PathKind,
  type Portage,
  type RiverPoint,
  type Route,
  type RouteFork,
  type Severity,
  type Track,
  type TrackFix,
} from './types';
import { isWaterLevel, isYmd, sanitizeObservation } from './observations';

export function toGeoJSON(points: RiverPoint[], routes: Route[], tracks: Track[] = [], portages: Portage[] = []) {
  return {
    type: 'FeatureCollection',
    features: [
      ...points.map(({ lat, lng, ...props }) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: { featureType: 'point', ...props },
      })),
      // Offline download state is device-specific, so it isn't exported.
      ...routes.map(({ coords, offline: _offline, ...props }) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords.map(([lat, lng]) => [lng, lat]) },
        properties: { featureType: 'route', ...props },
      })),
      // Fix times go in `coordTimes` (the common GeoJSON convention for GPS tracks).
      ...tracks.map(({ fixes, recording: _recording, ...props }) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: fixes.map(([lat, lng]) => [lng, lat]) },
        properties: {
          featureType: 'track',
          ...props,
          coordTimes: fixes.map(([, , t]) => (t ? new Date(t).toISOString() : null)),
          accuracies: fixes.map(([, , , acc]) => acc),
        },
      })),
      ...portages.map(({ coords, ...props }) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords.map(([lat, lng]) => [lng, lat]) },
        properties: { featureType: 'portage', ...props },
      })),
    ],
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A route's forks from a file, keeping only well-formed ones. */
function sanitizeForks(raw: unknown): RouteFork[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const forks = raw.flatMap((f: any): RouteFork[] => {
    if (!f || typeof f.id !== 'string' || !isNum(f.from) || !Array.isArray(f.coords)) return [];
    const coords = (f.coords as unknown[])
      .filter((c): c is [number, number] => Array.isArray(c) && isNum(c[0]) && isNum(c[1]))
      .slice(0, 5000)
      .map(([a, b]) => [a, b] as LatLng);
    if (coords.length < 2) return [];
    return [{ id: f.id.slice(0, 80), name: typeof f.name === 'string' ? f.name.slice(0, 120) : undefined, coords, from: f.from, rejoin: isNum(f.rejoin) ? f.rejoin : undefined }];
  });
  return forks.length ? forks : undefined;
}

/** A point's line/area from a file, if it's well-formed. */
function sanitizeShape(raw: any): RiverPoint['shape'] {
  if (!raw || (raw.kind !== 'line' && raw.kind !== 'area') || !Array.isArray(raw.coords)) return undefined;
  const coords = (raw.coords as unknown[])
    .filter((c): c is [number, number] => Array.isArray(c) && isNum(c[0]) && isNum(c[1]) && Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180)
    .slice(0, 5000)
    .map(([a, b]) => [a, b] as LatLng);
  return coords.length >= (raw.kind === 'area' ? 3 : 2) ? { kind: raw.kind, coords } : undefined;
}

export interface ParsedData {
  points: RiverPoint[];
  routes: Route[];
  tracks: Track[];
  portages: Portage[];
}

/**
 * Parse a GeoJSON FeatureCollection: Points become points; LineStrings become
 * tracks when marked as such, routes otherwise.
 */
export function fromGeoJSON(data: unknown): ParsedData {
  const fc = data as { type?: string; features?: unknown[] };
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Not a GeoJSON FeatureCollection');
  }
  const now = new Date().toISOString();
  const out: ParsedData = { points: [], routes: [], tracks: [], portages: [] };
  for (const f of fc.features as any[]) {
    const p = f?.properties ?? {};
    const base = {
      id: typeof p.id === 'string' ? p.id : crypto.randomUUID(),
      name: String(p.name ?? 'Untitled'),
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : now,
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : now,
    };
    if (f?.geometry?.type === 'Point') {
      const [lng, lat] = f.geometry.coordinates ?? [];
      if (!isNum(lat) || !isNum(lng)) continue;
      const category: Category = p.category in CATEGORIES ? p.category : 'poi';
      out.points.push({
        ...base,
        description: String(p.description ?? ''),
        category,
        lat,
        lng,
        riverMile: isNum(p.riverMile) ? p.riverMile : undefined,
        severity: ['low', 'medium', 'high'].includes(p.severity) ? (p.severity as Severity) : undefined,
        observedAt: isYmd(p.observedAt) ? p.observedAt : undefined,
        waterLevel: isWaterLevel(p.waterLevel) ? p.waterLevel : undefined,
        gauge: typeof p.gauge === 'string' && p.gauge ? p.gauge.slice(0, 200) : undefined,
        shape: sanitizeShape(p.shape),
        routeLink:
          p.routeLink?.detached === true
            ? { detached: true }
            : typeof p.routeLink?.routeId === 'string' && typeof p.routeLink?.branch === 'string' && isNum(p.routeLink?.km)
              ? { routeId: p.routeLink.routeId, branch: p.routeLink.branch, km: p.routeLink.km }
              : undefined,
        history: Array.isArray(p.history)
          ? (p.history.map(sanitizeObservation).filter(Boolean) as NonNullable<ReturnType<typeof sanitizeObservation>>[])
          : undefined,
      });
    } else if (f?.geometry?.type === 'LineString') {
      const raw: unknown[] = f.geometry.coordinates ?? [];
      const valid = raw
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => Array.isArray(c) && isNum(c[0]) && isNum(c[1])) as { c: number[]; i: number }[];
      if (valid.length < 2) continue;
      if (p.featureType === 'track') {
        const times: unknown[] = Array.isArray(p.coordTimes) ? p.coordTimes : [];
        const accs: unknown[] = Array.isArray(p.accuracies) ? p.accuracies : [];
        const fixes: TrackFix[] = valid.map(({ c, i }) => {
          const t = Date.parse(String(times[i] ?? ''));
          const acc = accs[i];
          return [c[1], c[0], Number.isFinite(t) ? t : 0, isNum(acc) ? acc : -1];
        });
        out.tracks.push({ ...base, fixes, source: p.source === 'gpx' ? 'gpx' : 'recorded' });
      } else if (p.featureType === 'portage') {
        out.portages.push({
          ...base,
          kind: (['portage', 'access'] as PathKind[]).includes(p.kind) ? p.kind : 'portage',
          description: String(p.description ?? ''),
          coords: valid.map(({ c }) => [c[1], c[0]] as LatLng),
          routeId: typeof p.routeId === 'string' ? p.routeId : undefined,
        });
      } else {
        const coords: LatLng[] = valid.map(({ c }) => [c[1], c[0]]);
        const lv = p.levels;
        const num = (v: unknown) => (isNum(v) ? v : undefined);
        out.routes.push({
          ...base,
          gaugeId: typeof p.gaugeId === 'string' && /^[A-Z]+-[\w-]+$/.test(p.gaugeId) ? p.gaugeId : undefined,
          levels:
            lv && (lv.param === '00060' || lv.param === '00065')
              ? { param: lv.param, low: num(lv.low), high: num(lv.high), flood: num(lv.flood) }
              : undefined,
          description: String(p.description ?? ''),
          color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : ROUTE_COLORS[out.routes.length % ROUTE_COLORS.length],
          coords,
          forks: sanitizeForks(p.forks),
        });
      }
    }
  }
  return out;
}
