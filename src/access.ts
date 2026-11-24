import L from 'leaflet';
import { map } from './map';
import { state } from './state';
import { KM_PER_MI } from './geo';
import { locateOnRoute, MAIN, positionOf, riverKm, type RoutePlace } from './routeGraph';
import type { LatLng, RiverPoint, Route } from './types';

/**
 * Access points (put-ins and take-outs) attach to a spot on a route: the
 * nearest spot on its main line or a fork within AUTO_KM, unless one was
 * picked by hand, or the point was detached.
 */
export const AUTO_KM = 0.3; // a big river is ~300 m wide: ramps on either bank attach

export interface AccessOnRoute {
  point: RiverPoint;
  place: RoutePlace;
  /** River distance from the route's start (km), following its miles. */
  riverKm: number;
  /** Picked by hand rather than automatic. */
  manual: boolean;
}

const isAccess = (p: RiverPoint) => p.category === 'access';

/** Where an access point meets a route, if it does. */
export function accessPlace(p: RiverPoint, r: Route): { place: RoutePlace; manual: boolean } | null {
  if (!isAccess(p)) return null;
  const link = p.routeLink;
  if (link && 'detached' in link) return null;
  if (link) {
    if (link.routeId !== r.id) return null;
    // A fork that no longer exists falls back to automatic.
    if (link.branch === MAIN || r.forks?.some((f) => f.id === link.branch)) return { place: { branch: link.branch, km: link.km }, manual: true };
  }
  const loc = locateOnRoute(r, [p.lat, p.lng]);
  return loc && loc.offKm <= AUTO_KM ? { place: { branch: loc.branch, km: loc.km }, manual: false } : null;
}

/** The route's access points, in river order. */
export function accessOn(r: Route): AccessOnRoute[] {
  return state.points
    .flatMap((point) => {
      const a = accessPlace(point, r);
      return a ? [{ point, place: a.place, riverKm: riverKm(r, a.place), manual: a.manual }] : [];
    })
    .sort((a, b) => a.riverKm - b.riverKm);
}

/** "On “Downtown Chattanooga” at mile 0.1 (automatic)" — or why not. */
export function linkSummary(p: RiverPoint): string {
  if (p.routeLink && 'detached' in p.routeLink) return 'Not attached to a route (detached).';
  const on = state.routes.flatMap((r) => {
    const a = accessPlace(p, r);
    if (!a) return [];
    const fork = a.place.branch !== MAIN ? r.forks?.find((f) => f.id === a.place.branch) : undefined;
    const where = fork ? ` (${fork.name || (fork.rejoin != null ? 'channel' : 'side branch')})` : '';
    return [`“${r.name}”${where} at mile ${(riverKm(r, a.place) / KM_PER_MI).toFixed(1)}${a.manual ? ' (spot picked by hand)' : ' (automatic)'}`];
  });
  return on.length ? `On ${on.join(' and ')}.` : `Not on a route (none within ${AUTO_KM * 1000} m).`;
}

/** Nearest spot on any route to a tap, for "Pick spot". */
export function nearestRouteSpot(at: LatLng, maxKm = 0.3): { route: Route; place: RoutePlace } | null {
  let best: { route: Route; place: RoutePlace; off: number } | null = null;
  for (const r of state.routes) {
    const loc = locateOnRoute(r, at);
    if (loc && loc.offKm <= maxKm && (!best || loc.offKm < best.off)) best = { route: r, place: { branch: loc.branch, km: loc.km }, off: loc.offKm };
  }
  return best && { route: best.route, place: best.place };
}

// ---------- connectors on the map ----------
const layer = L.layerGroup().addTo(map);

/** A thin dashed line from each attached access point to its spot on the route. */
export function renderAccessLinks() {
  layer.clearLayers();
  for (const r of state.routes) {
    for (const a of accessOn(r)) {
      const spot = positionOf(r, a.place);
      L.polyline([[a.point.lat, a.point.lng], spot], { color: '#27ae60', weight: 2, opacity: 0.8, dashArray: '3 4', interactive: false }).addTo(layer);
      L.circleMarker(spot, { radius: 4, color: '#fff', weight: 1.5, fillColor: '#27ae60', fillOpacity: 1, interactive: false }).addTo(layer);
    }
  }
}
