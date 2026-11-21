import { CATEGORIES, ROUTE_COLORS, type Category, type LatLng, type RiverPoint, type Route, type Severity } from './types';

export function toGeoJSON(points: RiverPoint[], routes: Route[]) {
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
    ],
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parse a GeoJSON FeatureCollection: Points become points, LineStrings become routes. */
export function fromGeoJSON(data: unknown): { points: RiverPoint[]; routes: Route[] } {
  const fc = data as { type?: string; features?: unknown[] };
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Not a GeoJSON FeatureCollection');
  }
  const now = new Date().toISOString();
  const points: RiverPoint[] = [];
  const routes: Route[] = [];
  for (const f of fc.features as any[]) {
    const p = f?.properties ?? {};
    const base = {
      id: typeof p.id === 'string' ? p.id : crypto.randomUUID(),
      name: String(p.name ?? 'Untitled'),
      description: String(p.description ?? ''),
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : now,
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : now,
    };
    if (f?.geometry?.type === 'Point') {
      const [lng, lat] = f.geometry.coordinates ?? [];
      if (!isNum(lat) || !isNum(lng)) continue;
      const category: Category = p.category in CATEGORIES ? p.category : 'poi';
      points.push({
        ...base,
        category,
        lat,
        lng,
        riverMile: isNum(p.riverMile) ? p.riverMile : undefined,
        severity: ['low', 'medium', 'high'].includes(p.severity) ? (p.severity as Severity) : undefined,
      });
    } else if (f?.geometry?.type === 'LineString') {
      const coords: LatLng[] = (f.geometry.coordinates ?? [])
        .filter((c: unknown) => Array.isArray(c) && isNum(c[0]) && isNum(c[1]))
        .map((c: number[]) => [c[1], c[0]]);
      if (coords.length < 2) continue;
      routes.push({
        ...base,
        color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : ROUTE_COLORS[routes.length % ROUTE_COLORS.length],
        coords,
      });
    }
  }
  return { points, routes };
}
