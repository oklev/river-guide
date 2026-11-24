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

/** Douglas–Peucker line simplification; `toleranceM` is the max deviation allowed, in metres. */
export function simplify(coords: LatLng[], toleranceM: number): LatLng[] {
  if (coords.length < 3) return coords.slice();
  const lat0 = rad(coords[0][0]);
  const xy = coords.map(([lat, lng]) => [lng * 111_320 * Math.cos(lat0), lat * 110_574] as const);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (xy[i][0] - ax) - dx * (xy[i][1] - ay)) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
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

/** Where a shaped point's marker goes: halfway along a line, or the middle of an area. */
export function shapeAnchor(kind: 'line' | 'area', coords: LatLng[]): LatLng {
  if (kind === 'line') {
    const half = lengthKm(coords) / 2;
    let done = 0;
    for (let i = 1; i < coords.length; i++) {
      const seg = distKm(coords[i - 1], coords[i]);
      if (done + seg >= half && seg > 0) {
        const f = (half - done) / seg;
        return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f];
      }
      done += seg;
    }
    return coords[0];
  }
  // Area-weighted centroid (falls back to the average of the corners for slivers).
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const [y0, x0] = coords[j];
    const [y1, x1] = coords[i];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    const n = coords.length || 1;
    return [coords.reduce((s, c) => s + c[0], 0) / n, coords.reduce((s, c) => s + c[1], 0) / n];
  }
  return [cy / (3 * a), cx / (3 * a)];
}
