import L from 'leaflet';
import { densify } from './geo';
import type { LatLng } from './types';

/**
 * Offline maps use USGS National Map topo tiles: public domain, CORS-enabled,
 * and (unlike OpenStreetMap's tile servers) fine to download for offline use.
 */
export const USGS_TOPO_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
export const USGS_MAX_ZOOM = 16;
export const OFFLINE_MIN_ZOOM = 6;
/** Rough average size of a USGS topo tile, for download estimates. */
export const AVG_TILE_BYTES = 22_000;

const TILE_CACHE = 'river-guide-tiles-v1';
// Cache Storage only exists in secure contexts (https or localhost).
const hasCaches = typeof caches !== 'undefined';
let cachePromise: Promise<Cache> | null = null;
const tileCache = () => (cachePromise ??= caches.open(TILE_CACHE));

const tileUrl = (z: number, x: number, y: number) =>
  USGS_TOPO_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

async function cachedTile(url: string): Promise<Blob | null> {
  if (!hasCaches) return null;
  try {
    const res = await (await tileCache()).match(url);
    return res ? await res.blob() : null;
  } catch {
    return null;
  }
}

/** Tile layer that serves downloaded tiles from Cache Storage, falling back to the network. */
export class OfflineTileLayer extends L.TileLayer {
  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement('img');
    tile.alt = '';
    tile.setAttribute('role', 'presentation');
    tile.crossOrigin = '';
    const url = this.getTileUrl(coords);
    tile.onload = () => {
      if (tile.src.startsWith('blob:')) URL.revokeObjectURL(tile.src);
      done(undefined, tile);
    };
    tile.onerror = () => done(new Error(`Tile failed: ${url}`), tile);
    void cachedTile(url).then((blob) => {
      tile.src = blob ? URL.createObjectURL(blob) : url;
    });
    return tile;
  }
}

const lngToX = (lng: number, n: number) => Math.floor(((lng + 180) / 360) * n);
function latToY(lat: number, n: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
}

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** All tiles covering a corridor of `bufferKm` on each side of the line. */
export function corridorTileCoords(coords: LatLng[], bufferKm: number, minZoom: number, maxZoom: number): TileCoord[] {
  const samples = densify(coords, bufferKm / 2);
  const seen = new Map<string, TileCoord>();
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z;
    for (const [lat, lng] of samples) {
      const dLat = bufferKm / 110.574;
      const dLng = bufferKm / (111.32 * Math.cos((lat * Math.PI) / 180));
      const x0 = lngToX(lng - dLng, n);
      const x1 = lngToX(lng + dLng, n);
      const y0 = latToY(lat + dLat, n);
      const y1 = latToY(lat - dLat, n);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) seen.set(`${z}/${x}/${y}`, { z, x, y });
    }
  }
  return [...seen.values()];
}

/** USGS topo tile URLs covering the corridor. */
export function corridorTiles(coords: LatLng[], bufferKm: number, minZoom: number, maxZoom: number): string[] {
  return corridorTileCoords(coords, bufferKm, minZoom, maxZoom).map(({ z, x, y }) => tileUrl(z, x, y));
}

export interface DownloadProgress {
  done: number;
  total: number;
  failed: number;
}

/** Download tiles into the offline cache, skipping ones already saved. */
export async function downloadTiles(
  urls: string[],
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<DownloadProgress> {
  if (!hasCaches) throw new Error('Offline storage needs a secure (https) connection.');
  const cache = await tileCache();
  const progress: DownloadProgress = { done: 0, total: urls.length, failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < urls.length && !signal.aborted) {
      const url = urls[next++];
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { signal });
          if (!res.ok) throw new Error(String(res.status));
          await cache.put(url, res);
        }
      } catch {
        if (signal.aborted) return;
        progress.failed++;
      }
      progress.done++;
      onProgress({ ...progress });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return progress;
}

export async function cachedTileCount(): Promise<number> {
  if (!hasCaches) return 0;
  return (await (await tileCache()).keys()).length;
}

export async function clearTiles(): Promise<void> {
  if (!hasCaches) return;
  cachePromise = null;
  await caches.delete(TILE_CACHE);
}
