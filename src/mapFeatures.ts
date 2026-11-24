import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { distKm, simplify } from './geo';
import { mapTileBytes, OSM_ZOOM } from './osm';
import type { LatLng } from './types';

/**
 * Islands and bridges on the base map (OpenStreetMap), so a tap on one can
 * offer to turn it into a River Guide point with its outline or line.
 *
 * Bridges are road/rail/path segments marked as bridges. Islands aren't
 * stored as shapes in the map data, so the land around the tap is filled in
 * on a small canvas of the surrounding water: if that patch is enclosed by
 * water, it's an island and its outline is traced.
 */
export type MapFeature =
  | { kind: 'island'; name?: string; ring: LatLng[] }
  | { kind: 'bridge'; name?: string; line: LatLng[] };

const Z = OSM_ZOOM;
const N = 2 ** Z;
/** Canvas pixels per tile when looking for islands (~8 m per pixel at z14). */
const PX = 256;
const BRIDGE_NEAR_M = 20;

const toTile = ([lat, lng]: LatLng) => ({
  fx: ((lng + 180) / 360) * N,
  fy: ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * N,
});
const toLatLng = (fx: number, fy: number): LatLng => [
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / N))) * 180) / Math.PI,
  (fx / N) * 360 - 180,
];

interface LoadedTile {
  x: number;
  y: number;
  vt: VectorTile;
}

/** The 3x3 block of tiles around a place (missing ones skipped). */
async function tilesAround(at: LatLng): Promise<{ tiles: LoadedTile[]; cx: number; cy: number; fx: number; fy: number }> {
  const { fx, fy } = toTile(at);
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  const jobs: Promise<LoadedTile | null>[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      jobs.push(
        mapTileBytes({ z: Z, x, y })
          .then((buf) => (buf ? { x, y, vt: new VectorTile(new PbfReader(new Uint8Array(buf))) } : null))
          .catch(() => null),
      );
    }
  }
  return { tiles: (await Promise.all(jobs)).filter((t): t is LoadedTile => !!t), cx, cy, fx, fy };
}

// ---------- bridges ----------
function distToSegM(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = (a[1] - p[1]) * k;
  const ay = a[0] - p[0];
  const bx = (b[1] - p[1]) * k;
  const by = b[0] - p[0];
  const dx = bx - ax;
  const dy = by - ay;
  const u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + u * dx, ay + u * dy) * 111_195;
}
const distToLineM = (p: LatLng, line: LatLng[]) =>
  line.reduce((m, _, i) => (i ? Math.min(m, distToSegM(p, line[i - 1], line[i])) : m), Infinity);

function linesOf(t: LoadedTile, layer: string): { props: Record<string, unknown>; line: LatLng[] }[] {
  const l = t.vt.layers[layer];
  if (!l) return [];
  const out = [];
  for (let i = 0; i < l.length; i++) {
    const f = l.feature(i);
    if (f.type !== 2) continue;
    for (const g of f.loadGeometry()) {
      out.push({ props: f.properties, line: g.map((p) => toLatLng(t.x + p.x / l.extent, t.y + p.y / l.extent)) });
    }
  }
  return out;
}

function findBridge(at: LatLng, tiles: LoadedTile[]): MapFeature | null {
  const segs = tiles.flatMap((t) => linesOf(t, 'transportation')).filter((s) => s.props.brunnel === 'bridge');
  let best: (typeof segs)[number] | undefined;
  let bestD = BRIDGE_NEAR_M;
  for (const s of segs) {
    const d = distToLineM(at, s.line);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (!best) return null;
  // Join on the connected pieces of the same bridge (split at tile edges and junctions).
  const line = [...best.line];
  const used = new Set([best]);
  const same = (a: LatLng, b: LatLng) => distKm(a, b) < 0.003;
  const dir = (a: LatLng, b: LatLng) => [b[1] - a[1], b[0] - a[0]];
  // Only pieces that carry on in roughly the same direction: not the other carriageway coming back.
  const continues = (from: LatLng, at: LatLng, next: LatLng) => {
    const [ax, ay] = dir(from, at);
    const [bx, by] = dir(at, next);
    return ax * bx + ay * by > 0;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of segs) {
      if (used.has(s) || s.props.class !== best.props.class || s.line.length < 2) continue;
      const fwd = s.line;
      const rev = [...s.line].reverse();
      const end = line[line.length - 1];
      const beforeEnd = line[line.length - 2] ?? end;
      const start = line[0];
      const afterStart = line[1] ?? start;
      let piece: LatLng[] | null = null;
      let atEnd = true;
      for (const cand of [fwd, rev]) {
        if (same(end, cand[0]) && continues(beforeEnd, end, cand[1])) piece = cand;
        else if (same(start, cand[cand.length - 1]) && continues(afterStart, start, cand[cand.length - 2])) {
          piece = cand;
          atEnd = false;
        }
        if (piece) break;
      }
      if (!piece) continue;
      if (atEnd) line.push(...piece.slice(1));
      else line.unshift(...piece.slice(0, -1));
      used.add(s);
      grew = true;
    }
  }
  // Name: a nearby street name, preferring one that is itself a bridge's name.
  const names = tiles
    .flatMap((t) => linesOf(t, 'transportation_name'))
    .filter((n) => typeof n.props.name === 'string' && distToLineM(line[Math.floor(line.length / 2)], n.line) < 40)
    .map((n) => String(n.props.name));
  const named = names.find((n) => /bridge/i.test(n)) ?? names[0];
  const rail = best.props.class === 'rail' || best.props.class === 'transit';
  const name = named ? (/bridge/i.test(named) ? named : `${named} Bridge`) : rail ? 'Railroad bridge' : undefined;
  return { kind: 'bridge', name, line: simplify(line, 3) };
}

// ---------- islands ----------
function findIsland(tiles: LoadedTile[], cx: number, cy: number, fx: number, fy: number): MapFeature | null {
  const size = PX * 3;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  let anyWater = false;
  for (const t of tiles) {
    const water = t.vt.layers.water;
    if (!water) continue;
    const ox = (t.x - cx + 1) * PX;
    const oy = (t.y - cy + 1) * PX;
    const k = PX / water.extent;
    for (let i = 0; i < water.length; i++) {
      const f = water.feature(i);
      if (f.type !== 3) continue;
      ctx.beginPath();
      for (const ring of f.loadGeometry()) {
        ring.forEach((p, j) => (j ? ctx.lineTo(ox + p.x * k, oy + p.y * k) : ctx.moveTo(ox + p.x * k, oy + p.y * k)));
        ctx.closePath();
      }
      ctx.fill('evenodd');
      anyWater = true;
    }
  }
  if (!anyWater) return null;
  const img = ctx.getImageData(0, 0, size, size).data;
  const isWater = (x: number, y: number) => img[(y * size + x) * 4 + 3] > 127;
  const sx = Math.floor((fx - cx + 1) * PX);
  const sy = Math.floor((fy - cy + 1) * PX);
  if (isWater(sx, sy)) return null; // tapped the water itself

  // Flood-fill the land patch; touching the edge of the 3x3 block means it's mainland (or too big).
  const filled = new Uint8Array(size * size);
  const stack = [sy * size + sx];
  filled[stack[0]] = 1;
  let count = 0;
  while (stack.length) {
    const idx = stack.pop()!;
    count++;
    const x = idx % size;
    const y = (idx - x) / size;
    if (x === 0 || y === 0 || x === size - 1 || y === size - 1) return null;
    for (const n of [idx - 1, idx + 1, idx - size, idx + size]) {
      if (!filled[n] && !isWater(n % size, Math.floor(n / size))) {
        filled[n] = 1;
        stack.push(n);
      }
    }
  }
  if (count < 6) return null; // a speck: a bridge pier or a gap in the data

  // Trace the outline: Moore-neighbour tracing, clockwise from the top-left pixel.
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size && filled[y * size + x] === 1;
  let start = 0;
  while (!filled[start]) start++;
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]; // E SE S SW W NW N NE
  const sx0 = start % size;
  const sy0 = (start - sx0) / size;
  const pts: [number, number][] = [[sx0, sy0]];
  let x = sx0;
  let y = sy0;
  let back = 4; // the pixel to the west of the start is outside
  for (let steps = 0; steps < 4 * size * size; steps++) {
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      if (inside(x + dirs[d][0], y + dirs[d][1])) {
        found = d;
        break;
      }
    }
    if (found < 0) break; // a single pixel
    // The last outside neighbour checked becomes the backtrack, seen from the new pixel.
    const bx = x + dirs[(found + 7) % 8][0];
    const by = y + dirs[(found + 7) % 8][1];
    x += dirs[found][0];
    y += dirs[found][1];
    back = dirs.findIndex(([dx, dy]) => dx === bx - x && dy === by - y);
    if (x === sx0 && y === sy0) break;
    pts.push([x, y]);
  }
  const ring = pts.map(([px, py]) => toLatLng(cx - 1 + (px + 0.5) / PX, cy - 1 + (py + 0.5) / PX));

  // Its name, if the map has one inside the patch.
  let name: string | undefined;
  for (const t of tiles) {
    const place = t.vt.layers.place;
    if (!place) continue;
    for (let i = 0; i < place.length && !name; i++) {
      const f = place.feature(i);
      if (!/^(island|islet)$/.test(String(f.properties.class)) || typeof f.properties.name !== 'string') continue;
      const p = f.loadGeometry()[0]?.[0];
      if (!p) continue;
      const px = Math.floor((t.x - cx + 1 + p.x / place.extent) * PX);
      const py = Math.floor((t.y - cy + 1 + p.y / place.extent) * PX);
      if (inside(px, py)) name = f.properties.name;
    }
  }
  const simple = simplify(ring, 6);
  return simple.length >= 3 ? { kind: 'island', name, ring: simple } : null;
}

/** An island or bridge on the map at this place, if there is one. */
export async function mapFeatureAt(at: LatLng): Promise<MapFeature | null> {
  const { tiles, cx, cy, fx, fy } = await tilesAround(at);
  if (!tiles.length) return null;
  return findBridge(at, tiles) ?? findIsland(tiles, cx, cy, fx, fy);
}
