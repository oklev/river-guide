import L from 'leaflet';
import { layersControl, map } from './map';
import { state } from './state';
import { del, put } from './store';
import { distKm, locateOnLine } from './geo';
import type { LatLng, NavFeature, NavKind, Route, RouteNav } from './types';
import { escapeHtml, getMode, prefs } from './ui';

/**
 * Navigation-channel data from the US Army Corps of Engineers' Inland
 * Electronic Navigational Charts (ienccloud.us): the barge sailing line,
 * channel markers, restricted areas, charted hazards and the bridge spans
 * barges use. Public, keyless and CORS-enabled. Only commercially navigable
 * rivers are charted, so most small rivers simply have nothing.
 *
 * Fetched per route (a few KB each) whenever online, and kept for offline use.
 */
const API = 'https://ienccloud.us/arcgis/rest/services/IENC/USACE_IENC_Master_Service/MapServer';
/** Keep chart features within this distance of the route line (km)… */
const PAD_KM = 1;
/** …and follow the river this far above the put-in and below the take-out (routes run downstream). */
const UPSTREAM_KM = 3;
const DOWNSTREAM_KM = 5;
/** Re-check the charts this often (they're updated monthly). */
const NAV_TTL = 30 * 24 * 3600_000;
/** Bump when what's fetched or kept changes, so saved data is refreshed. */
const NAV_DATA_VERSION = 4;

const LAYERS: { id: number; kind: NavKind; label: string }[] = [
  { id: 46, kind: 'sailing-line', label: 'Sailing line' },
  { id: 15, kind: 'mark', label: 'Channel buoy' },
  { id: 14, kind: 'mark', label: 'Channel light' },
  { id: 6, kind: 'mark', label: 'Special-purpose buoy' },
  { id: 2, kind: 'danger-mark', label: 'Isolated danger buoy' },
  { id: 83, kind: 'restricted', label: 'Restricted area' },
  { id: 19, kind: 'hazard', label: 'Obstruction' },
  { id: 42, kind: 'hazard', label: 'Obstruction' },
  { id: 81, kind: 'hazard', label: 'Obstruction' },
  { id: 28, kind: 'hazard', label: 'Underwater rock' },
  { id: 53, kind: 'hazard', label: 'Underwater rocks' },
  { id: 31, kind: 'hazard', label: 'Wreck' },
  { id: 54, kind: 'hazard', label: 'Wreck' },
  { id: 92, kind: 'barge-span', label: 'Bridge' },
];

const layer = L.featureGroup();
const cache = new Map<string, RouteNav>();
const inFlight = new Set<string>();

// ---------- fetching ----------
/** Fingerprint of a route line, so an edited route gets fresh chart data. */
function routeKey(r: Route): string {
  let h = 0;
  for (const [lat, lng] of r.coords) h = (h * 31 + Math.round(lat * 1e5) * 7 + Math.round(lng * 1e5)) | 0;
  return `v${NAV_DATA_VERSION}:${r.coords.length}:${h}`;
}

function bbox(coords: LatLng[], km: number): string {
  const lats = coords.map((c) => c[0]);
  const lngs = coords.map((c) => c[1]);
  const dLat = km / 110.574;
  const dLng = km / (111.32 * Math.cos((lats[0] * Math.PI) / 180));
  return [Math.min(...lngs) - dLng, Math.min(...lats) - dLat, Math.max(...lngs) + dLng, Math.max(...lats) + dLat]
    .map((n) => n.toFixed(5))
    .join(',');
}

async function queryLayer(id: number, box: string): Promise<any[]> {
  const params = new URLSearchParams({
    f: 'json',
    where: '1=1',
    geometry: box,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    geometryPrecision: '6',
  });
  const res = await fetch(`${API}/${id}/query?${params}`);
  if (!res.ok) throw new Error(`Nav charts ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? 'Nav charts error');
  return json.features ?? [];
}

const str = (a: Record<string, unknown>, k: string) => {
  const v = a[k];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};
const num = (a: Record<string, unknown>, k: string) => {
  const v = parseFloat(String(a[k] ?? ''));
  return Number.isFinite(v) ? v : undefined;
};

/** Within PAD_KM of a line (the route, extended along the river). */
const nearRoute = (corridor: LatLng[], p: LatLng) => (locateOnLine(corridor, p)?.offKm ?? Infinity) <= PAD_KM;

/** Walk along a polyline from index i in direction dir (±1) for km, returning the points passed. */
function walk(line: LatLng[], i: number, dir: 1 | -1, km: number): LatLng[] {
  const out: LatLng[] = [];
  let done = 0;
  for (let j = i + dir; j >= 0 && j < line.length && done < km; j += dir) {
    done += distKm(line[j - dir], line[j]);
    out.push(line[j]);
  }
  return out;
}

function nearestVertex(line: LatLng[], p: LatLng): { i: number; d: number } {
  let best = { i: -1, d: Infinity };
  line.forEach((q, i) => {
    const d = distKm(p, q);
    if (d < best.d) best = { i, d };
  });
  return best;
}

/**
 * The route plus the river UPSTREAM_KM above its put-in and DOWNSTREAM_KM below
 * its take-out, following the charted sailing line so distances are measured
 * along the river (around bends), not as the crow flies. Routes are assumed to
 * be drawn downstream.
 */
function riverCorridor(route: LatLng[], sailing: LatLng[][]): LatLng[] {
  const start = route[0];
  const end = route[route.length - 1];
  for (const line of sailing) {
    const s = nearestVertex(line, start);
    const e = nearestVertex(line, end);
    if (s.d > PAD_KM || e.d > PAD_KM || s.i === e.i) continue;
    const down: 1 | -1 = e.i > s.i ? 1 : -1;
    const above = walk(line, s.i, (-down) as 1 | -1, UPSTREAM_KM).reverse();
    const below = walk(line, e.i, down, DOWNSTREAM_KM);
    return [...above, ...route, ...below];
  }
  return route; // no charted channel here
}

/** Split a polyline into the runs that pass near the route. */
function clipLine(route: LatLng[], line: LatLng[]): LatLng[][] {
  const near = line.map((p) => nearRoute(route, p));
  const runs: LatLng[][] = [];
  let run: LatLng[] = [];
  for (let i = 0; i < line.length; i++) {
    // Keep one point either side of each run so it reaches the corridor edge.
    if (near[i] || near[i - 1] || near[i + 1]) run.push(line[i]);
    else if (run.length) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

function toFeature(route: LatLng[], kind: NavKind, label: string, f: any): NavFeature | null {
  const a: Record<string, unknown> = f.attributes ?? {};
  const g = f.geometry ?? {};
  const categoryKey = Object.keys(a).find((k) => k.startsWith('Category_of_'));
  const base: NavFeature = {
    kind,
    name: str(a, 'Object_Name'),
    info: str(a, 'Information'),
    color: str(a, 'Color'),
    category: (categoryKey && str(a, categoryKey)) || label,
  };
  if (kind === 'barge-span') {
    if (base.info !== 'Primary Navigation Span') return null;
    base.clearanceFt = num(a, 'Vertical_Clearance') ?? num(a, 'Vertical_Clearance_Closed');
    base.widthFt = num(a, 'Horizontal_Clearance');
  }
  const isNear = (p: LatLng) => nearRoute(route, p);
  if (typeof g.x === 'number') {
    const point: LatLng = [g.y, g.x];
    return isNear(point) ? { ...base, point } : null;
  }
  if (g.paths) {
    const lines = (g.paths as [number, number][][]).flatMap((p) => clipLine(route, p.map(([x, y]) => [y, x] as LatLng)));
    return lines.length ? { ...base, lines } : null;
  }
  if (g.rings) {
    const rings = (g.rings as [number, number][][]).map((r) => r.map(([x, y]) => [y, x] as LatLng));
    return rings.some((r) => r.some(isNear)) ? { ...base, rings } : null;
  }
  return null;
}

async function fetchNav(r: Route): Promise<NavFeature[]> {
  // Generous box: anything DOWNSTREAM_KM along the river is within that distance in a straight line.
  const box = bbox(r.coords, Math.max(PAD_KM, UPSTREAM_KM, DOWNSTREAM_KM));
  const [sailingLayer, ...rest] = LAYERS;
  // The sailing line comes first: it defines how far the corridor runs up and down the river.
  const sailing = (await queryLayer(sailingLayer.id, box)).flatMap((f: any) =>
    ((f.geometry?.paths ?? []) as [number, number][][]).map((p) => p.map(([x, y]) => [y, x] as LatLng)),
  );
  const corridor = riverCorridor(r.coords, sailing);
  const out: NavFeature[] = [];
  const lines = sailing.flatMap((l) => clipLine(corridor, l));
  if (lines.length) out.push({ kind: 'sailing-line', category: sailingLayer.label, lines });
  // A few requests at a time, to be polite to the server.
  for (let i = 0; i < rest.length; i += 4) {
    const batch = rest.slice(i, i + 4);
    const results = await Promise.all(batch.map((l) => queryLayer(l.id, box)));
    results.forEach((features, j) => {
      for (const f of features) {
        const nf = toFeature(corridor, batch[j].kind, batch[j].label, f);
        if (nf) out.push(nf);
      }
    });
  }
  return out;
}

/** Fetch chart data for any route that has none yet, was edited, or is a month old. */
export async function refreshNav() {
  if (!navigator.onLine) return;
  for (const r of [...state.routes]) {
    const key = routeKey(r);
    const have = cache.get(r.id);
    if (have && have.key === key && Date.now() - Date.parse(have.fetchedAt) < NAV_TTL) continue;
    if (inFlight.has(r.id)) continue;
    inFlight.add(r.id);
    try {
      const rec: RouteNav = { routeId: r.id, key, fetchedAt: new Date().toISOString(), features: await fetchNav(r) };
      if (!state.routes.some((x) => x.id === r.id)) continue; // deleted meanwhile
      cache.set(r.id, rec);
      await put('nav', rec);
      renderNav();
    } catch {
      /* keep what we had; try again next time */
    } finally {
      inFlight.delete(r.id);
    }
  }
}

export function setNav(list: RouteNav[]) {
  cache.clear();
  for (const n of list) cache.set(n.routeId, n);
}

export async function forgetNav(routeId: string) {
  cache.delete(routeId);
  await del('nav', routeId);
  renderNav();
}

// ---------- display ----------
const bankText = (info?: string) =>
  info === 'LDB' ? 'On the left bank (looking downstream).' : info === 'RDB' ? 'On the right bank (looking downstream).' : '';

function popupHtml(f: NavFeature): string {
  const src = '<div class="popup-updated">USACE navigation chart</div>';
  const name = f.name ? escapeHtml(f.name) : '';
  switch (f.kind) {
    case 'sailing-line':
      return `<b>Barge sailing line</b><p>Commercial tows follow this line. They can't stop or steer around a kayak, so cross it quickly at a right angle and don't linger in it.</p>${src}`;
    case 'mark': {
      const c = f.color?.toLowerCase() ?? '';
      const side = c.startsWith('red')
        ? 'Red marks the <b>left</b> edge of the channel heading downstream (the right edge heading upstream: “red, right, returning”).'
        : c.startsWith('green')
          ? 'Green marks the <b>right</b> edge of the channel heading downstream (the left edge heading upstream).'
          : '';
      return `<b>${name || escapeHtml(`${f.color ?? ''} ${f.category ?? 'marker'}`.trim())}</b><p>${side} ${bankText(f.info)} Barges pass on the channel side of it.</p>${src}`;
    }
    case 'danger-mark':
      return `<b>${name || 'Isolated danger'}</b><p>Marks an obstruction with navigable water all around it.</p>${src}`;
    case 'restricted':
      return `<b>Restricted area</b>${f.category && f.category !== 'Restricted area' ? `<div class="muted small">${escapeHtml(f.category)}</div>` : ''}<p>${escapeHtml(f.info ?? 'Boats are restricted here.')}</p>${src}`;
    case 'hazard':
      return `<b>${escapeHtml(f.category ?? 'Charted hazard')}</b>${name ? `<div>${name}</div>` : ''}${f.info ? `<p>${escapeHtml(f.info)}</p>` : ''}${src}`;
    case 'barge-span': {
      const dims = [f.widthFt && `${f.widthFt} ft wide`, f.clearanceFt && `${f.clearanceFt} ft clearance`].filter(Boolean).join(', ');
      return `<b>Barge span${name ? ` · ${name}` : ''}</b><p>The span commercial traffic uses${dims ? ` (${dims})` : ''}. Use a different span if you can, and look upstream and downstream before passing under.</p>${src}`;
    }
  }
}

const STYLE: Record<Exclude<NavKind, 'mark' | 'danger-mark'>, L.PathOptions> = {
  'sailing-line': { color: '#8e24aa', weight: 3, opacity: 0.85, dashArray: '10 8' },
  restricted: { color: '#c62828', weight: 2, dashArray: '6 4', fillOpacity: 0.12 },
  hazard: { color: '#ef6c00', weight: 2, fillOpacity: 0.25 },
  'barge-span': { color: '#8e24aa', weight: 1, fillOpacity: 0.4 },
};

function markIcon(f: NavFeature) {
  const c = f.color?.toLowerCase() ?? '';
  const cls = f.kind === 'danger-mark' ? 'danger' : c.startsWith('red') ? 'red' : c.startsWith('green') ? 'green' : 'other';
  return L.divIcon({ className: '', html: `<div class="nav-mark ${cls}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
}

function draw(f: NavFeature): L.Layer | null {
  if (f.point) {
    if (f.kind === 'hazard') return L.circleMarker(f.point, { radius: 6, color: '#ef6c00', weight: 2, fillOpacity: 0.6 });
    return L.marker(f.point, { icon: markIcon(f), keyboard: false });
  }
  const style = STYLE[f.kind as keyof typeof STYLE] ?? STYLE.hazard;
  if (f.lines) return L.polyline(f.lines, { ...style, fill: false });
  if (f.rings) return L.polygon(f.rings, style);
  return null;
}

/** Same feature seen from two overlapping routes is drawn once. */
const featureId = (f: NavFeature) =>
  `${f.kind}|${f.name ?? ''}|${JSON.stringify(f.point ?? f.rings?.[0]?.[0] ?? f.lines?.[0]?.[0])}`;

export function renderNav() {
  layer.clearLayers();
  const seen = new Set<string>();
  const routeIds = new Set(state.routes.map((r) => r.id));
  for (const nav of cache.values()) {
    if (!routeIds.has(nav.routeId)) continue;
    for (const f of nav.features) {
      const id = featureId(f);
      if (f.kind !== 'sailing-line' && seen.has(id)) continue;
      seen.add(id);
      const l = draw(f);
      if (!l) continue;
      l.on('click', (e: L.LeafletMouseEvent) => {
        if (getMode() !== 'idle') return;
        L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(popupHtml(f)).openOn(map);
      });
      layer.addLayer(l);
    }
  }
  // Keep the channel under routes and points.
  layer.bringToBack();
}

export function initNav() {
  layersControl.addOverlay(layer, 'Navigation channel (USACE)');
  if (prefs.get('navOverlay') !== 'off') layer.addTo(map);
  map.on('overlayadd', (e: L.LayersControlEvent) => e.layer === layer && prefs.set('navOverlay', 'on'));
  map.on('overlayremove', (e: L.LayersControlEvent) => e.layer === layer && prefs.set('navOverlay', 'off'));
  window.addEventListener('online', () => void refreshNav());
}
