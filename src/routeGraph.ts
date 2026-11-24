import { distKm, lengthKm, locateOnLine } from './geo';
import type { LatLng, Route, RouteFork } from './types';

/**
 * A route as a small network: its main line plus forks. A fork leaves the
 * main line at `from` km and either rejoins it at `rejoin` km (a channel
 * around an island) or ends on its own (a side branch, e.g. up a tributary).
 *
 * Places on the network are { branch, km }: branch 'main' or a fork's ID,
 * km along that line. River miles follow the main line; along a channel
 * they're spread between where it leaves and rejoins, along a side branch
 * they carry on from where it leaves.
 */
export interface RoutePlace {
  branch: string;
  km: number;
}

export const MAIN = 'main';

export function branchCoords(r: Route, branch: string): LatLng[] {
  return branch === MAIN ? r.coords : (r.forks?.find((f) => f.id === branch)?.coords ?? []);
}

export const allLines = (r: Route): LatLng[][] => [r.coords, ...(r.forks ?? []).map((f) => f.coords)];

/** The nearest place on the route (main line or any fork) to a position. */
export function locateOnRoute(r: Route, p: LatLng): (RoutePlace & { offKm: number }) | null {
  let best: (RoutePlace & { offKm: number }) | null = null;
  for (const [branch, coords] of [[MAIN, r.coords], ...(r.forks ?? []).map((f) => [f.id, f.coords])] as [string, LatLng[]][]) {
    const loc = locateOnLine(coords, p);
    if (loc && (!best || loc.offKm < best.offKm)) best = { branch, km: loc.alongKm, offKm: loc.offKm };
  }
  return best;
}

/** River mile (in km from the start of the main line) of a place on the route. */
export function riverKm(r: Route, place: RoutePlace): number {
  if (place.branch === MAIN) return place.km;
  const f = r.forks?.find((x) => x.id === place.branch);
  if (!f) return place.km;
  if (f.rejoin == null) return f.from + place.km;
  const len = lengthKm(f.coords) || 1;
  return f.from + (place.km / len) * (f.rejoin - f.from);
}

/** The position of a place on the route. */
export function positionOf(r: Route, place: RoutePlace): LatLng {
  return pointAlong(branchCoords(r, place.branch), place.km);
}

export function pointAlong(coords: LatLng[], km: number): LatLng {
  let done = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = distKm(coords[i - 1], coords[i]);
    if (done + seg >= km && seg > 0) {
      const f = (km - done) / seg;
      return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f];
    }
    done += seg;
  }
  return coords[coords.length - 1];
}

/** The part of a line between two distances along it (in that direction; reversed if b < a). */
export function sliceLine(coords: LatLng[], a: number, b: number): LatLng[] {
  if (b < a) return sliceLine(coords, b, a).reverse();
  const out: LatLng[] = [pointAlong(coords, a)];
  let done = 0;
  for (let i = 1; i < coords.length; i++) {
    done += distKm(coords[i - 1], coords[i]);
    if (done > a && done < b) out.push(coords[i]);
  }
  out.push(pointAlong(coords, b));
  return out;
}

// ---------- paths through the network ----------
/** Graph nodes are places; edges run along lines between consecutive nodes on the same branch. */
interface Node {
  branch: string;
  km: number;
}

/**
 * The shortest way along the route between two places (through forks if
 * needed). Returns the path's coordinates and length, or null if they aren't
 * connected.
 */
export function pathBetween(r: Route, a: RoutePlace, b: RoutePlace): { coords: LatLng[]; km: number } | null {
  // Nodes: both ends, the ends of every line, and where forks meet the main line.
  const nodes: Node[] = [a, b];
  const forks = r.forks ?? [];
  const mainLen = lengthKm(r.coords);
  nodes.push({ branch: MAIN, km: 0 }, { branch: MAIN, km: mainLen });
  for (const f of forks) {
    const len = lengthKm(f.coords);
    nodes.push({ branch: f.id, km: 0 }, { branch: f.id, km: len }, { branch: MAIN, km: f.from });
    if (f.rejoin != null) nodes.push({ branch: MAIN, km: f.rejoin });
  }
  const key = (n: Node) => `${n.branch}@${n.km.toFixed(5)}`;
  const uniq = new Map<string, Node>();
  for (const n of nodes) uniq.set(key(n), n);
  const list = [...uniq.values()];
  const index = new Map(list.map((n, i) => [key(n), i]));
  const edges: { to: number; km: number }[][] = list.map(() => []);
  const link = (i: number, j: number, km: number) => {
    edges[i].push({ to: j, km });
    edges[j].push({ to: i, km });
  };
  // Along each branch, between consecutive nodes.
  const byBranch = new Map<string, number[]>();
  list.forEach((n, i) => byBranch.set(n.branch, [...(byBranch.get(n.branch) ?? []), i]));
  for (const ids of byBranch.values()) {
    ids.sort((x, y) => list[x].km - list[y].km);
    for (let k = 1; k < ids.length; k++) link(ids[k - 1], ids[k], list[ids[k]].km - list[ids[k - 1]].km);
  }
  // Junctions: a fork's ends are the same place as its spots on the main line.
  for (const f of forks) {
    link(index.get(key({ branch: f.id, km: 0 }))!, index.get(key({ branch: MAIN, km: f.from }))!, 0);
    if (f.rejoin != null) link(index.get(key({ branch: f.id, km: lengthKm(f.coords) }))!, index.get(key({ branch: MAIN, km: f.rejoin }))!, 0);
  }
  // Dijkstra (the graph is tiny).
  const start = index.get(key(a))!;
  const goal = index.get(key(b))!;
  const dist = list.map(() => Infinity);
  const prev = list.map(() => -1);
  const done = list.map(() => false);
  dist[start] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < list.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity) break;
    if (u === goal) break;
    done[u] = true;
    for (const e of edges[u]) {
      if (dist[u] + e.km < dist[e.to]) {
        dist[e.to] = dist[u] + e.km;
        prev[e.to] = u;
      }
    }
  }
  if (dist[goal] === Infinity) return null;
  const order: number[] = [];
  for (let v = goal; v >= 0; v = prev[v]) order.unshift(v);
  const coords: LatLng[] = [];
  for (let k = 1; k < order.length; k++) {
    const p = list[order[k - 1]];
    const q = list[order[k]];
    if (p.branch !== q.branch) continue; // a junction hop: no distance
    const piece = sliceLine(branchCoords(r, p.branch), p.km, q.km);
    coords.push(...(coords.length ? piece.slice(1) : piece));
  }
  if (!coords.length) coords.push(positionOf(r, a));
  return { coords, km: dist[goal] };
}

/** Build a fork from a drawn line: it must start near the main line; ending near it makes a channel. */
export function forkFromDrawing(r: Route, drawn: LatLng[], id: string, name?: string): RouteFork | string {
  if (drawn.length < 2) return 'Draw at least two points.';
  const start = locateOnLine(r.coords, drawn[0]);
  if (!start || start.offKm > 0.2) return 'Start the fork on the route line (within 200 m of it).';
  const coords = [pointAlong(r.coords, start.alongKm), ...drawn.slice(1)];
  const end = locateOnLine(r.coords, drawn[drawn.length - 1]);
  // Ends back on the main line (and not right where it left): a channel that rejoins.
  if (end && end.offKm <= 0.1 && Math.abs(end.alongKm - start.alongKm) > 0.05) {
    coords[coords.length - 1] = pointAlong(r.coords, end.alongKm);
    return { id, name, coords, from: start.alongKm, rejoin: end.alongKm };
  }
  return { id, name, coords, from: start.alongKm };
}
