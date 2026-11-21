import type { LatLng, Route } from './types';

export const KM_PER_MI = 1.609344;
const EARTH_RADIUS_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function distKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function lengthKm(coords: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distKm(coords[i - 1], coords[i]);
  return total;
}

export const lengthMi = (coords: LatLng[]) => lengthKm(coords) / KM_PER_MI;

/**
 * Project a point onto a polyline. Returns the distance along the line from its
 * first vertex to the closest spot, and how far the point is from the line.
 */
export function locateOnLine(coords: LatLng[], p: LatLng): { alongKm: number; offKm: number } | null {
  if (coords.length < 2) return null;
  // Local flat projection centred on p; accurate enough at river scales.
  const kx = 111.32 * Math.cos(rad(p[0]));
  const ky = 110.574;
  let best = { alongKm: 0, offKm: Infinity };
  let acc = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const ax = (a[1] - p[1]) * kx;
    const ay = (a[0] - p[0]) * ky;
    const dx = (b[1] - p[1]) * kx - ax;
    const dy = (b[0] - p[0]) * ky - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    const segKm = distKm(a, b);
    if (off < best.offKm) best = { alongKm: acc + t * segKm, offKm: off };
    acc += segKm;
  }
  return best;
}

export function nearestRoute(routes: Route[], p: LatLng) {
  let best: { route: Route; alongKm: number; offKm: number } | null = null;
  for (const route of routes) {
    const loc = locateOnLine(route.coords, p);
    if (loc && (!best || loc.offKm < best.offKm)) best = { route, ...loc };
  }
  return best;
}

/** Insert intermediate points so no gap along the line exceeds `spacingKm`. */
export function densify(coords: LatLng[], spacingKm: number): LatLng[] {
  if (coords.length < 2) return coords.slice();
  const out: LatLng[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const n = Math.max(1, Math.ceil(distKm(a, b) / spacingKm));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
