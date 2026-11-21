import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { clearStore, count, getAll, hasKey, put } from './store';
import type { DownloadProgress, TileCoord } from './tiles';
import type { Category, LatLng, OsmFeature } from './types';

/**
 * Trails, parks and amenities come from OpenFreeMap's OpenStreetMap vector
 * tiles (OpenMapTiles schema). OpenFreeMap's terms allow offline downloads of
 * up to 3,000 tiles / 50 MB per download with at most 4 parallel requests.
 * We only need zoom 14, which holds full detail and stays far below the cap.
 */
export const OSM_ZOOM = 14;
export const OFM_MAX_TILES = 3000;
const OFM_PARALLEL = 4;
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

export interface PoiType {
  label: string;
  icon: string;
  /** Category used when converting to one of your own points. */
  category: Category;
  /** Hidden below this zoom to avoid clutter. */
  minZoom: number;
  /** Only shown inside a park (e.g. trailhead parking, not every office lot). */
  onlyInParks?: boolean;
}

/** Keyed by OpenMapTiles `class/subclass` (checked first) or `class`. */
export const POI_TYPES: Record<string, PoiType> = {
  campsite: { label: 'Campsite', icon: '⛺', category: 'campsite', minZoom: 12 },
  shelter: { label: 'Shelter', icon: '🛖', category: 'campsite', minZoom: 13 },
  harbor: { label: 'Marina / harbor', icon: '⚓', category: 'access', minZoom: 12 },
  'attraction/viewpoint': { label: 'Viewpoint', icon: '👁', category: 'poi', minZoom: 13 },
  'attraction/waterfall': { label: 'Waterfall', icon: '💧', category: 'hazard', minZoom: 12 },
  waterfall: { label: 'Waterfall', icon: '💧', category: 'hazard', minZoom: 12 },
  picnic_site: { label: 'Picnic area', icon: '🧺', category: 'poi', minZoom: 14 },
  toilets: { label: 'Restrooms', icon: '🚻', category: 'poi', minZoom: 13 },
  drinking_water: { label: 'Drinking water', icon: '🚰', category: 'poi', minZoom: 14 },
  parking: { label: 'Parking', icon: 'P', category: 'poi', minZoom: 14, onlyInParks: true },
};

export const poiType = (cls: string, sub?: string): PoiType | undefined =>
  (sub && POI_TYPES[`${cls}/${sub}`]) || POI_TYPES[cls];

const TRAIL_CLASSES = new Set(['path', 'track']);

// ---------- decoding ----------
interface Pt {
  x: number;
  y: number;
}

/** Sutherland–Hodgman clip of a ring to the tile square, so neighbouring tiles' fills don't overlap. */
function clipRing(ring: Pt[], ext: number): Pt[] {
  const planes: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p.x >= 0, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= ext, (a, b) => ({ x: ext, y: a.y + ((b.y - a.y) * (ext - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= 0, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [(p) => p.y <= ext, (a, b) => ({ x: a.x + ((b.x - a.x) * (ext - a.y)) / (b.y - a.y), y: ext })],
  ];
  let out = ring;
  for (const [inside, cross] of planes) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cross(prev, cur));
      }
    }
    if (!out.length) break;
  }
  return out;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export function decodeTile(buf: ArrayBuffer, t: TileCoord): OsmFeature[] {
  const vt = new VectorTile(new PbfReader(new Uint8Array(buf)));
  const n = 2 ** t.z;
  const projector = (ext: number) => (p: Pt): LatLng => {
    const lng = ((t.x + p.x / ext) / n) * 360 - 180;
    const yr = Math.PI * (1 - (2 * (t.y + p.y / ext)) / n);
    return [round6((Math.atan(Math.sinh(yr)) * 180) / Math.PI), round6(lng)];
  };
  const out: OsmFeature[] = [];

  const parks = vt.layers.park;
  for (let i = 0; parks && i < parks.length; i++) {
    const f = parks.feature(i);
    if (f.type !== 3) continue;
    const toLL = projector(f.extent);
    for (const poly of classifyRings(f.loadGeometry())) {
      const rings = poly.map((r) => clipRing(r, f.extent));
      if (rings[0].length < 3) continue; // outer ring is outside this tile
      out.push({
        kind: 'park',
        cls: String(f.properties.class ?? 'park'),
        name: str(f.properties.name),
        geom: rings.filter((r) => r.length >= 3).map((r) => r.map(toLL)),
      });
    }
  }

  for (const [layerName, kind] of [
    ['transportation', 'path'],
    ['transportation_name', 'trail'],
  ] as const) {
    const layer = vt.layers[layerName];
    for (let i = 0; layer && i < layer.length; i++) {
      const f = layer.feature(i);
      const cls = String(f.properties.class);
      if (f.type !== 2 || !TRAIL_CLASSES.has(cls)) continue;
      const name = str(f.properties.name);
      if (kind === 'trail' && !name) continue;
      const toLL = projector(f.extent);
      out.push({ kind, cls, sub: str(f.properties.subclass), name, geom: f.loadGeometry().map((l) => l.map(toLL)) });
    }
  }

  const pois = vt.layers.poi;
  for (let i = 0; pois && i < pois.length; i++) {
    const f = pois.feature(i);
    const cls = String(f.properties.class);
    const sub = str(f.properties.subclass);
    if (f.type !== 1 || !poiType(cls, sub)) continue;
    const toLL = projector(f.extent);
    for (const part of f.loadGeometry()) {
      for (const p of part) {
        // Skip copies in the tile's buffer zone; the neighbouring tile owns them.
        if (p.x < 0 || p.y < 0 || p.x >= f.extent || p.y >= f.extent) continue;
        out.push({ kind: 'poi', cls, sub, name: str(f.properties.name), geom: [[toLL(p)]] });
      }
    }
  }
  return out;
}

async function maybeGunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buf;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

// ---------- downloading ----------
async function tileTemplate(signal: AbortSignal): Promise<string> {
  const res = await fetch(TILEJSON_URL, { signal });
  if (!res.ok) throw new Error(`OpenFreeMap unavailable (${res.status})`);
  const url = (await res.json())?.tiles?.[0];
  if (typeof url !== 'string') throw new Error('Unexpected OpenFreeMap response');
  return url;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchTile(url: string, signal: AbortSignal): Promise<ArrayBuffer | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal });
    if (res.ok) return res.status === 204 ? null : maybeGunzip(await res.arrayBuffer());
    if (res.status === 404) return null; // no data here (e.g. open ocean)
    if (attempt >= 2 || !(res.status === 429 || res.status >= 500)) throw new Error(String(res.status));
    await sleep(1000 * 2 ** attempt);
  }
}

/** Download, decode and store OSM features for the given z14 tiles. Already-saved tiles are skipped. */
export async function downloadOsm(
  tiles: TileCoord[],
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<DownloadProgress> {
  if (tiles.length > OFM_MAX_TILES) throw new Error(`Too many trail-data tiles (${tiles.length})`);
  const progress: DownloadProgress = { done: 0, total: tiles.length, failed: 0 };
  const todo: TileCoord[] = [];
  for (const t of tiles) {
    if (await hasKey('osm', `${t.z}/${t.x}/${t.y}`)) progress.done++;
    else todo.push(t);
  }
  onProgress({ ...progress });
  if (!todo.length) return progress;

  const template = await tileTemplate(signal);
  let next = 0;
  const worker = async () => {
    while (next < todo.length && !signal.aborted) {
      const t = todo[next++];
      const url = template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
      try {
        const buf = await fetchTile(url, signal);
        await put('osm', {
          key: `${t.z}/${t.x}/${t.y}`,
          fetchedAt: new Date().toISOString(),
          features: buf ? decodeTile(buf, t) : [],
        });
      } catch {
        if (signal.aborted) return;
        progress.failed++;
      }
      progress.done++;
      onProgress({ ...progress });
    }
  };
  await Promise.all(Array.from({ length: OFM_PARALLEL }, worker));
  return progress;
}

export const loadAllOsm = () => getAll('osm');
export const clearOsm = () => clearStore('osm');
export const osmTileCount = () => count('osm');
