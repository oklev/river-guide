import type { Gauge, OfflineArea, Photo, Portage, RiverPoint, Route, Track } from './types';

export const state = {
  points: [] as RiverPoint[],
  routes: [] as Route[],
  tracks: [] as Track[],
  /** Photo metadata and thumbnails; full images live in the photoBlobs store. */
  photos: [] as Photo[],
  portages: [] as Portage[],
  /** USGS gauges seen near routes or in the map view (cached readings). */
  gauges: [] as Gauge[],
};

/** Every corridor downloaded for a route. */
export function offlineAreas(r: Route): OfflineArea[] {
  const o = r.offline;
  if (!o) return [];
  // Downloads made before areas were tracked: best guess from the current line.
  return o.areas ?? [{ coords: r.coords, bufferKm: o.bufferKm, maxZoom: o.maxZoom, osm: o.osmTiles != null }];
}

export const allOfflineAreas = () => state.routes.flatMap(offlineAreas);
