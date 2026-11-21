import type { OfflineArea, RiverPoint, Route } from './types';

export const state = {
  points: [] as RiverPoint[],
  routes: [] as Route[],
};

/** Every corridor downloaded for a route. */
export function offlineAreas(r: Route): OfflineArea[] {
  const o = r.offline;
  if (!o) return [];
  // Downloads made before areas were tracked: best guess from the current line.
  return o.areas ?? [{ coords: r.coords, bufferKm: o.bufferKm, maxZoom: o.maxZoom, osm: o.osmTiles != null }];
}

export const allOfflineAreas = () => state.routes.flatMap(offlineAreas);
