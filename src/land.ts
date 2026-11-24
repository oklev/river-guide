import L from 'leaflet';
import { layersControl, map } from './map';
import { state } from './state';
import { del, put } from './store';
import { densify, distKm } from './geo';
import { allLines } from './routeGraph';
import type { LandAccess, LandArea, LatLng, Route, RouteLand } from './types';
import { escapeHtml, prefs } from './ui';

/**
 * Public and protected land along routes, from the USGS Protected Areas
 * Database (PAD-US): federal, state and local parks, forests and wildlife
 * areas, TVA and Corps land, and conservation land held by land trusts. Each
 * area says who manages it and whether the public may use it. Public,
 * keyless and CORS-enabled.
 *
 * Fetched per route whenever online (like the navigation charts) and kept,
 * so it works on the water. Banks that aren't shaded are most likely private.
 */
const API = 'https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Fee_Managers_PADUS/FeatureServer/0';
/** Land counts as "along the route" if any of its boundary is this close to a route line (km)… */
const NEAR_KM = 0.6;
/** …and is trimmed to the route's bounding box plus this margin, so huge holdings (all of TVA's land) stay small. */
const CLIP_KM = 1.2;
/** Simplify boundaries to about this (degrees, ~7 m): plenty for seeing which bank is which. */
const SIMPLIFY_DEG = 0.00006;
/** PAD-US is updated about once a year. */
const LAND_TTL = 60 * 24 * 3600_000;
/** Bump when what's fetched or kept changes, so saved data is refreshed. */
const LAND_DATA_VERSION = 1;
const OVERLAY_NAME = 'Public land (PAD-US)';

const layer = L.featureGroup();
const cache = new Map<string, RouteLand>();
const inFlight = new Set<string>();

// ---------- describing land ----------
const MANAGERS: Record<string, string> = {
  TVA: 'Tennessee Valley Authority',
  USACE: 'US Army Corps of Engineers',
  NPS: 'National Park Service',
  USFS: 'US Forest Service',
  FWS: 'US Fish & Wildlife Service',
  BLM: 'Bureau of Land Management',
  BOR: 'Bureau of Reclamation',
  DOD: 'Department of Defense',
  DOE: 'Department of Energy',
  NOAA: 'NOAA',
  NRCS: 'Natural Resources Conservation Service',
  BIA: 'Bureau of Indian Affairs',
  OTHF: 'Other federal agency',
  SFW: 'State fish & wildlife agency',
  SPR: 'State parks',
  SDC: 'State conservation department',
  SDNR: 'State natural resources department',
  SDOL: 'State land department',
  SLB: 'State land board',
  OTHS: 'Other state agency',
  REG: 'Regional agency',
  RWD: 'Regional water district',
  CITY: 'City',
  CNTY: 'County',
  JNT: 'Jointly managed',
  NGO: 'Land trust or nonprofit',
  PVT: 'Private',
  TRIB: 'Tribal land',
  UNIV: 'University',
  UNK: 'Unknown manager',
};

const DESIGNATIONS: Record<string, string> = {
  LP: 'Local park',
  LREC: 'Local recreation area',
  LCA: 'Local conservation area',
  LHCA: 'Local historic or cultural area',
  LOTH: 'Local land',
  SP: 'State park',
  SREC: 'State recreation area',
  SCA: 'State conservation area',
  SHCA: 'State historic or cultural area',
  SW: 'State wilderness',
  SOTH: 'State land',
  NP: 'National park',
  NF: 'National forest',
  NWR: 'National wildlife refuge',
  NRA: 'National recreation area',
  NM: 'National monument',
  HCA: 'Historic or cultural area',
  WA: 'Wilderness area',
  WSR: 'Wild and scenic river',
  REC: 'Recreation area',
  RNA: 'Research natural area',
  FOTH: 'Federal land',
  PREC: 'Private recreation area',
  PCON: 'Private conservation land',
  PHCA: 'Private historic or cultural area',
  POTH: 'Protected land',
  TRIBL: 'Tribal land',
};

const ACCESS: Record<string, LandAccess> = { OA: 'open', RA: 'restricted', XA: 'closed', UK: 'unknown' };

const ACCESS_TEXT: Record<LandAccess, string> = {
  open: 'Open to the public',
  restricted: 'Public, with restrictions (permits, hours or seasons)',
  closed: 'Closed to the public',
  unknown: 'Public access not recorded',
};

/** Public agencies (as opposed to land trusts, private and tribal land). */
const isPublicAgency = (a: LandArea) => ['FED', 'STAT', 'LOC', 'DIST', 'JNT'].includes(a.managerType);

/** How an area is drawn: green open, olive restricted, red closed, blue-grey unknown. */
function styleFor(a: LandArea): L.PathOptions {
  const color =
    a.access === 'open' ? '#2e7d32' : a.access === 'restricted' ? '#7cb342' : a.access === 'closed' ? '#c62828' : isPublicAgency(a) ? '#43a047' : '#78909c';
  return {
    color,
    weight: 1,
    opacity: 0.7,
    fillColor: color,
    fillOpacity: a.access === 'closed' ? 0.12 : 0.18,
    dashArray: a.access === 'unknown' ? '4 3' : undefined,
    interactive: false,
  };
}

function note(a: LandArea): string {
  if (a.managerCode === 'TVA') {
    return 'TVA land along its reservoirs is generally open for informal recreation like landing, picnicking and primitive camping, unless it is posted otherwise.';
  }
  if (a.managerCode === 'USACE') return 'Corps land around its lakes and dams is often open for recreation, but areas near dams and locks are restricted.';
  if (a.access === 'closed') return 'Stay off unless you have permission.';
  if (a.managerType === 'PVT') return a.access === 'open' ? 'Privately owned but open to the public.' : 'Privately owned.';
  if (a.managerType === 'NGO' && a.access === 'unknown') return 'Conservation land: some is open to visitors, some isn’t. Look for signs.';
  if (a.managerType === 'TRIB') return 'Tribal land: ask before landing.';
  if (a.access === 'unknown') return 'PAD-US doesn’t record whether the public may use it. Look for signs.';
  return '';
}

/** Popup section for the land at a spot (or a note that none is recorded). */
export function landPopupHtml(areas: LandArea[]): string {
  const src = '<div class="popup-updated">USGS Protected Areas Database (PAD-US)</div>';
  if (!areas.length) {
    return `<div class="land-info"><b>No public land recorded here</b><p>This bank is most likely private. The riverbed belongs to the state and you may paddle past, but ask before landing or crossing.</p>${src}</div>`;
  }
  const items = areas
    .map((a) => {
      const meta = [a.designation, a.manager].filter(Boolean).join(' · ');
      const n = note(a);
      return `<div class="land-item"><b><span class="land-swatch" style="background:${styleFor(a).color}"></span>${escapeHtml(a.name)}</b>
        <div class="muted small">${escapeHtml(meta)}</div>
        <div>${ACCESS_TEXT[a.access]}.</div>${n ? `<p class="small">${escapeHtml(n)}</p>` : ''}</div>`;
    })
    .join('');
  return `<div class="land-info">${items}${src}</div>`;
}

// ---------- fetching ----------
/** Fingerprint of a route and its forks, so an edited route gets fresh land data. */
function routeKey(r: Route): string {
  let h = 0;
  let n = 0;
  for (const line of allLines(r)) {
    for (const [lat, lng] of line) h = (h * 31 + Math.round(lat * 1e4) * 7 + Math.round(lng * 1e4)) | 0;
    n += line.length;
  }
  return `v${LAND_DATA_VERSION}:${n}:${h}`;
}

interface Box {
  s: number;
  w: number;
  n: number;
  e: number;
}

function boxAround(lines: LatLng[][], km: number): Box {
  const pts = lines.flat();
  const lats = pts.map((c) => c[0]);
  const lngs = pts.map((c) => c[1]);
  const dLat = km / 110.574;
  const dLng = km / (111.32 * Math.cos((lats[0] * Math.PI) / 180));
  return { s: Math.min(...lats) - dLat, w: Math.min(...lngs) - dLng, n: Math.max(...lats) + dLat, e: Math.max(...lngs) + dLng };
}

/** Clip a ring to a box (Sutherland–Hodgman, one edge at a time). */
export function clipRing(ring: LatLng[], b: Box): LatLng[] {
  type Edge = { inside: (p: LatLng) => boolean; cut: (p: LatLng, q: LatLng) => LatLng };
  const atLat = (lat: number) => (p: LatLng, q: LatLng): LatLng => [lat, p[1] + ((q[1] - p[1]) * (lat - p[0])) / (q[0] - p[0])];
  const atLng = (lng: number) => (p: LatLng, q: LatLng): LatLng => [p[0] + ((q[0] - p[0]) * (lng - p[1])) / (q[1] - p[1]), lng];
  const edges: Edge[] = [
    { inside: (p) => p[0] >= b.s, cut: atLat(b.s) },
    { inside: (p) => p[0] <= b.n, cut: atLat(b.n) },
    { inside: (p) => p[1] >= b.w, cut: atLng(b.w) },
    { inside: (p) => p[1] <= b.e, cut: atLng(b.e) },
  ];
  let out = ring;
  for (const edge of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (edge.inside(p)) {
        if (!edge.inside(prev)) out.push(edge.cut(prev, p));
        out.push(p);
      } else if (edge.inside(prev)) out.push(edge.cut(prev, p));
    }
    if (!out.length) break;
  }
  return out;
}

/** Quick "is this near a route line" test: route lines sampled every 100 m in a grid of ~1 km cells. */
function nearTester(lines: LatLng[][], km: number): (p: LatLng) => boolean {
  const CELL = 0.01;
  const grid = new Map<string, LatLng[]>();
  const cell = (lat: number, lng: number) => `${Math.floor(lat / CELL)},${Math.floor(lng / CELL)}`;
  for (const line of lines) {
    for (const p of line.length > 1 ? densify(line, 0.1) : line) {
      const k = cell(p[0], p[1]);
      const list = grid.get(k);
      if (list) list.push(p);
      else grid.set(k, [p]);
    }
  }
  // Samples are 100 m apart, so a point within km of the line is within km + 0.05 of a sample.
  const reach = km + 0.05;
  const span = Math.ceil(reach / 0.8) + 1; // cells are at least ~0.8 km wide at US latitudes
  return (p) => {
    const ci = Math.floor(p[0] / CELL);
    const cj = Math.floor(p[1] / CELL);
    for (let i = ci - span; i <= ci + span; i++) {
      for (let j = cj - span; j <= cj + span; j++) {
        for (const q of grid.get(`${i},${j}`) ?? []) if (distKm(p, q) <= reach) return true;
      }
    }
    return false;
  };
}

async function query(box: Box, offset: number): Promise<{ features: any[]; more: boolean }> {
  const params = new URLSearchParams({
    f: 'json',
    where: '1=1',
    geometry: [box.w, box.s, box.e, box.n].map((n) => n.toFixed(5)).join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'Unit_Nm,Loc_Nm,Mang_Type,Mang_Name,Loc_Mang,Des_Tp,Pub_Access',
    returnGeometry: 'true',
    maxAllowableOffset: String(SIMPLIFY_DEG),
    geometryPrecision: '5',
    resultOffset: String(offset),
    resultRecordCount: '1000',
  });
  const res = await fetch(`${API}/query?${params}`);
  if (!res.ok) throw new Error(`PAD-US ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? 'PAD-US error');
  return { features: json.features ?? [], more: !!json.exceededTransferLimit };
}

const str = (a: Record<string, unknown>, k: string) => {
  const v = a[k];
  return typeof v === 'string' && v.trim() && v.trim() !== 'Unknown' ? v.trim() : undefined;
};

/** Turn one PAD-US record into a LandArea trimmed to the route, or null if none of it is near. */
export function toArea(f: any, near: (p: LatLng) => boolean, clip: Box): LandArea | null {
  const a: Record<string, unknown> = f.attributes ?? {};
  const rings: LatLng[][] = [];
  for (const raw of (f.geometry?.rings ?? []) as [number, number][][]) {
    const ring = raw.map(([x, y]) => [y, x] as LatLng);
    // Skip rings wholly outside the box before the (slower) distance test.
    if (!ring.some((p) => p[0] >= clip.s && p[0] <= clip.n && p[1] >= clip.w && p[1] <= clip.e)) continue;
    if (!ring.some(near)) continue;
    const clipped = clipRing(ring, clip);
    if (clipped.length >= 3) rings.push(clipped);
  }
  if (!rings.length) return null;
  const code = str(a, 'Mang_Name') ?? 'UNK';
  return {
    name: str(a, 'Unit_Nm') ?? str(a, 'Loc_Nm') ?? MANAGERS[code] ?? 'Protected land',
    manager: str(a, 'Loc_Mang') && !['UNK', code].includes(str(a, 'Loc_Mang')!) ? str(a, 'Loc_Mang')! : (MANAGERS[code] ?? code),
    managerType: str(a, 'Mang_Type') ?? 'UNK',
    managerCode: code,
    access: ACCESS[str(a, 'Pub_Access') ?? 'UK'] ?? 'unknown',
    designation: DESIGNATIONS[str(a, 'Des_Tp') ?? ''],
    rings,
  };
}

async function fetchLand(r: Route): Promise<LandArea[]> {
  const lines = allLines(r).filter((l) => l.length);
  const near = nearTester(lines, NEAR_KM);
  const clip = boxAround(lines, CLIP_KM);
  const box = boxAround(lines, NEAR_KM);
  const out: LandArea[] = [];
  for (let offset = 0; offset < 10_000; ) {
    const { features, more } = await query(box, offset);
    for (const f of features) {
      const area = toArea(f, near, clip);
      if (area) out.push(area);
    }
    if (!more || !features.length) break;
    offset += features.length;
  }
  return out;
}

/** Fetch land data for any route that has none yet, was edited, or is a couple of months old. */
export async function refreshLand() {
  if (!navigator.onLine) return;
  for (const r of [...state.routes]) {
    if (!r.coords.length) continue;
    const key = routeKey(r);
    const have = cache.get(r.id);
    if (have && have.key === key && Date.now() - Date.parse(have.fetchedAt) < LAND_TTL) continue;
    if (inFlight.has(r.id)) continue;
    inFlight.add(r.id);
    try {
      const rec: RouteLand = { routeId: r.id, key, fetchedAt: new Date().toISOString(), areas: await fetchLand(r) };
      if (!state.routes.some((x) => x.id === r.id)) continue; // deleted meanwhile
      cache.set(r.id, rec);
      await put('land', rec);
      renderLand();
    } catch {
      /* keep what we had; try again next time */
    } finally {
      inFlight.delete(r.id);
    }
  }
}

export function setLand(list: RouteLand[]) {
  cache.clear();
  for (const n of list) cache.set(n.routeId, n);
}

export async function forgetLand(routeId: string) {
  cache.delete(routeId);
  await del('land', routeId);
  renderLand();
}

// ---------- display ----------
/** The same area seen from two overlapping routes is drawn once. */
const areaId = (a: LandArea) => `${a.name}|${a.managerCode}|${a.rings[0]?.[0]?.join(',')}`;

function visibleAreas(): LandArea[] {
  const routeIds = new Set(state.routes.map((r) => r.id));
  const seen = new Set<string>();
  const out: LandArea[] = [];
  for (const rec of cache.values()) {
    if (!routeIds.has(rec.routeId)) continue;
    for (const a of rec.areas) {
      const id = areaId(a);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(a);
    }
  }
  return out;
}

export function renderLand() {
  layer.clearLayers();
  for (const a of visibleAreas()) layer.addLayer(L.polygon(a.rings, styleFor(a)));
  layer.bringToBack();
}

export const landShown = () => map.hasLayer(layer);

function inRings(rings: LatLng[][], [lat, lng]: LatLng): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [yi, xi] = r[i];
      const [yj, xj] = r[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Land at a spot, smallest first (a park inside a bigger holding comes first).
 * `null` if the spot is outside the area land data was fetched for.
 */
export function landAt(p: LatLng): LandArea[] | null {
  const routeIds = new Set(state.routes.map((r) => r.id));
  const covered = state.routes.some((r) => routeIds.has(r.id) && cache.has(r.id) && nearTester(allLines(r), NEAR_KM)(p));
  const hits = visibleAreas().filter((a) => inRings(a.rings, p));
  if (!hits.length && !covered) return null;
  const size = (a: LandArea) => {
    const b = boxAround(a.rings, 0);
    return (b.n - b.s) * (b.e - b.w);
  };
  return hits.sort((x, y) => size(x) - size(y));
}

export function initLand() {
  layersControl.addOverlay(layer, OVERLAY_NAME);
  if (prefs.get('landOverlay') !== 'off') layer.addTo(map);
  map.on('overlayadd', (e: L.LayersControlEvent) => e.layer === layer && prefs.set('landOverlay', 'on'));
  map.on('overlayremove', (e: L.LayersControlEvent) => e.layer === layer && prefs.set('landOverlay', 'off'));
  window.addEventListener('online', () => void refreshLand());
}
