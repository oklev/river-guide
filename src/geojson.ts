import { CATEGORIES, type Category, type RiverPoint, type Severity } from './types';

export function toGeoJSON(points: RiverPoint[]) {
  return {
    type: 'FeatureCollection',
    features: points.map(({ lat, lng, ...props }) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: props,
    })),
  };
}

/** Parse a GeoJSON FeatureCollection; non-point features are skipped. */
export function fromGeoJSON(data: unknown): RiverPoint[] {
  const fc = data as { type?: string; features?: unknown[] };
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Not a GeoJSON FeatureCollection');
  }
  const now = new Date().toISOString();
  const out: RiverPoint[] = [];
  for (const f of fc.features as any[]) {
    if (f?.geometry?.type !== 'Point') continue;
    const [lng, lat] = f.geometry.coordinates ?? [];
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const p = f.properties ?? {};
    const category: Category = p.category in CATEGORIES ? p.category : 'poi';
    out.push({
      id: typeof p.id === 'string' ? p.id : crypto.randomUUID(),
      name: String(p.name ?? 'Untitled'),
      category,
      description: String(p.description ?? ''),
      lat,
      lng,
      riverMile: typeof p.riverMile === 'number' ? p.riverMile : undefined,
      severity: ['low', 'medium', 'high'].includes(p.severity) ? (p.severity as Severity) : undefined,
      createdAt: p.createdAt ?? now,
      updatedAt: p.updatedAt ?? now,
    });
  }
  return out;
}
