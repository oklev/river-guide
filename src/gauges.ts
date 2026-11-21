import L from 'leaflet';
import { layersControl, map } from './map';
import { state } from './state';
import { put } from './store';
import { distKm, locateOnLine } from './geo';
import { GAUGE_PARAMS, type Gauge, type GaugeParam, type Route, type RouteLevels, type WaterLevel } from './types';
import { escapeHtml, getMode, prefs } from './ui';

/**
 * Live river gauges from the USGS Water Data APIs (api.waterdata.usgs.gov,
 * OGC API). No key needed and CORS-enabled. The legacy waterservices.usgs.gov
 * API is being shut down in early 2027, so it isn't used.
 */
const API = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections';
const PARAMS: GaugeParam[] = ['00060', '00065'];
/** How far around a route to look for gauges (km). */
const ROUTE_PAD_KM = 8;
/** Re-fetch latest readings after this long (ms). */
const LATEST_TTL = 15 * 60_000;
const SERIES_TTL = 30 * 60_000;
/** Look up gauges in the visible map area from this zoom level. */
const VIEW_MIN_ZOOM = 10;

const layer = L.layerGroup();
const markers = new Map<string, L.Marker>();
const findGauge = (id: string) => state.gauges.find((g) => g.id === id);

/** Gauges whose newest reading is older than this are treated as out of service. */
const ACTIVE_WINDOW = 7 * 24 * 3600_000;

/**
 * Whether a gauge was still reporting when we last checked it. Measured against
 * the fetch time, not "now", so cached gauges don't disappear while offline.
 */
export function isActive(g: Gauge): boolean {
  const times = PARAMS.map((p) => Date.parse(g.latest[p]?.time ?? '')).filter(Number.isFinite);
  if (!times.length) return false;
  const checked = Date.parse(g.latestFetchedAt) || Date.now();
  return checked - Math.max(...times) <= ACTIVE_WINDOW;
}
const activeGauges = () => state.gauges.filter(isActive);

// ---------- fetching ----------
async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USGS ${res.status}`);
  return res.json();
}

type BBox = [number, number, number, number]; // west, south, east, north
function padBox(coords: [number, number][], km: number): BBox {
  const lats = coords.map((c) => c[0]);
  const lngs = coords.map((c) => c[1]);
  const dLat = km / 110.574;
  const dLng = km / (111.32 * Math.cos((lats[0] * Math.PI) / 180));
  return [Math.min(...lngs) - dLng, Math.min(...lats) - dLat, Math.max(...lngs) + dLng, Math.max(...lats) + dLat];
}

/** "NORTH OCONEE RIVER AT COLLEGE ST, AT ATHENS, GA" → "North Oconee River at College St, at Athens, GA" */
function prettyName(raw: string): string {
  const small = new Set(['at', 'near', 'nr', 'of', 'and', 'below', 'above', 'abv', 'blw', 'on', 'in']);
  return raw
    .toLowerCase()
    .split(/(\s+|,)/)
    .map((w, i, all) => {
      if (/^\s+$|^,$/.test(w) || !w) return w;
      const isLast = all.slice(i + 1).every((x) => /^\s*,?\s*$/.test(x));
      if (isLast && w.length === 2) return w.toUpperCase(); // state code
      if (i > 0 && small.has(w)) return w;
      return w[0].toUpperCase() + w.slice(1);
    })
    .join('');
}

/** Latest flow/stage for every gauge in a bounding box; merges into the cache. */
async function fetchLatest(bbox: BBox): Promise<Gauge[]> {
  const url = `${API}/latest-continuous/items?f=json&bbox=${bbox.map((n) => n.toFixed(4)).join(',')}&parameter_code=${PARAMS.join(',')}&limit=500&skipGeometry=false`;
  const json = await getJson(url);
  const now = new Date().toISOString();
  const byId = new Map<string, Gauge>();
  for (const f of json.features ?? []) {
    const p = f.properties ?? {};
    const id = String(p.monitoring_location_id ?? '');
    const value = Number(p.value);
    const [lng, lat] = f.geometry?.coordinates ?? [];
    if (!id || !Number.isFinite(value) || !PARAMS.includes(p.parameter_code) || typeof lat !== 'number') continue;
    const g =
      byId.get(id) ??
      ({ ...(findGauge(id) ?? { id, name: id, lat, lng }), lat, lng, latest: {}, latestFetchedAt: now } as Gauge);
    g.latest[p.parameter_code as GaugeParam] = { value, time: p.time };
    byId.set(id, g);
  }
  const gauges = [...byId.values()];
  await fillNames(gauges.filter((g) => g.name === g.id));
  for (const g of gauges) await saveGauge(g);
  return gauges;
}

async function fillNames(gauges: Gauge[]) {
  for (let i = 0; i < gauges.length; i += 50) {
    const chunk = gauges.slice(i, i + 50);
    try {
      const json = await getJson(
        `${API}/monitoring-locations/items?f=json&skipGeometry=true&properties=monitoring_location_name&id=${chunk.map((g) => g.id).join(',')}`,
      );
      for (const f of json.features ?? []) {
        const g = chunk.find((x) => x.id === f.id);
        if (g && f.properties?.monitoring_location_name) g.name = prettyName(f.properties.monitoring_location_name);
      }
    } catch {
      /* names are cosmetic; keep the ID */
    }
  }
}

async function saveGauge(g: Gauge) {
  const i = state.gauges.findIndex((x) => x.id === g.id);
  if (i >= 0) state.gauges[i] = { ...state.gauges[i], ...g };
  else state.gauges.push(g);
  await put('gauges', i >= 0 ? state.gauges[i] : g);
}

/** Last 7 days for a gauge (only the parameters it reports). */
async function fetchSeries(g: Gauge): Promise<void> {
  if (g.seriesFetchedAt && Date.now() - Date.parse(g.seriesFetchedAt) < SERIES_TTL) return;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const series: Gauge['series'] = {};
  for (const param of PARAMS.filter((p) => g.latest[p])) {
    const json = await getJson(
      `${API}/continuous/items?f=json&skipGeometry=true&properties=time,value&limit=3000&monitoring_location_id=${g.id}&parameter_code=${param}&datetime=${since}/..`,
    );
    series[param] = (json.features ?? [])
      .map((f: any) => [Date.parse(f.properties.time), Number(f.properties.value)] as [number, number])
      .filter(([t, v]: [number, number]) => Number.isFinite(t) && Number.isFinite(v))
      .sort((a: [number, number], b: [number, number]) => a[0] - b[0]);
  }
  g.series = series;
  g.seriesFetchedAt = new Date().toISOString();
  await saveGauge(g);
}

/** Daily mean on a past date (YYYY-MM-DD), for backfilled observations. */
export async function dailyMean(id: string, param: GaugeParam, ymd: string): Promise<number | null> {
  const json = await getJson(
    `${API}/daily/items?f=json&skipGeometry=true&properties=time,value&monitoring_location_id=${id}&parameter_code=${param}&statistic_id=00003&datetime=${ymd}`,
  );
  const v = Number(json.features?.[0]?.properties?.value);
  return Number.isFinite(v) ? v : null;
}

// ---------- refreshing ----------
let refreshing = false;
const viewFetched = new Map<string, number>();
/** When each route's surroundings were last searched, keyed by route ID + line (so edits re-search). */
const routeFetched = new Map<string, number>();
const routeKey = (r: Route) => `${r.id}:${r.coords.length}:${r.coords[0]}:${r.coords[r.coords.length - 1]}`;

/** Refresh gauges around every route (and the current view when zoomed in). */
export async function refreshGauges(opts: { force?: boolean } = {}) {
  if (!navigator.onLine || refreshing) return;
  refreshing = true;
  try {
    for (const r of state.routes) {
      const key = routeKey(r);
      if (!opts.force && Date.now() - (routeFetched.get(key) ?? 0) < LATEST_TTL) continue;
      await fetchLatest(padBox(r.coords, ROUTE_PAD_KM));
      routeFetched.set(key, Date.now());
    }
    await refreshView();
  } catch (err) {
    console.warn('gauge refresh failed', err);
  } finally {
    refreshing = false;
    renderGauges();
    document.dispatchEvent(new CustomEvent('gauges-changed'));
  }
}

async function refreshView() {
  if (map.getZoom() < VIEW_MIN_ZOOM || !map.hasLayer(layer)) return;
  const b = map.getBounds();
  const key = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(2)).join(',');
  if (Date.now() - (viewFetched.get(key) ?? 0) < LATEST_TTL) return;
  viewFetched.set(key, Date.now());
  await fetchLatest([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
}

/** Make sure a specific gauge's latest reading is fresh (when online). */
export async function freshGauge(id: string): Promise<Gauge | undefined> {
  const g = findGauge(id);
  if (g && navigator.onLine && Date.now() - Date.parse(g.latestFetchedAt) > LATEST_TTL) {
    try {
      await fetchLatest([g.lng - 0.01, g.lat - 0.01, g.lng + 0.01, g.lat + 0.01]);
      renderGauges();
    } catch {
      /* use the cached reading */
    }
  }
  return findGauge(id);
}

// ---------- routes & levels ----------
/** Active gauges within reach of a route, nearest first (plus the route's chosen gauge, even if inactive). */
export function gaugesNearRoute(r: Route, km = ROUTE_PAD_KM): { gauge: Gauge; offKm: number }[] {
  return state.gauges
    .filter((g) => isActive(g) || g.id === r.gaugeId)
    .map((gauge) => ({ gauge, offKm: locateOnLine(r.coords, [gauge.lat, gauge.lng])?.offKm ?? Infinity }))
    .filter((x) => x.offKm <= km || x.gauge.id === r.gaugeId)
    .sort((a, b) => a.offKm - b.offKm);
}

/** The route's chosen gauge, or the nearest one as a suggestion. */
export function routeGauge(r: Route): { gauge: Gauge; chosen: boolean } | null {
  const chosen = r.gaugeId ? findGauge(r.gaugeId) : undefined;
  if (chosen) return { gauge: chosen, chosen: true };
  const near = gaugesNearRoute(r, 3).find((x) => x.offKm <= 3);
  return near ? { gauge: near.gauge, chosen: false } : null;
}

export function nearestGauge(lat: number, lng: number, maxKm = 15): Gauge | undefined {
  return activeGauges()
    .map((g) => ({ g, d: distKm([lat, lng], [g.lat, g.lng]) }))
    .filter((x) => x.d <= maxKm)
    .sort((a, b) => a.d - b.d)[0]?.g;
}

/** Classify a reading against a route's runnable ranges. */
export function levelFor(levels: RouteLevels | undefined, value: number | undefined): WaterLevel | undefined {
  if (!levels || value == null) return undefined;
  if (levels.flood != null && value >= levels.flood) return 'flood';
  if (levels.high != null && value > levels.high) return 'high';
  if (levels.low != null && value < levels.low) return 'low';
  if (levels.low != null || levels.high != null) return 'normal';
  return undefined;
}

export const LEVEL_LABELS: Record<WaterLevel, { label: string; color: string }> = {
  low: { label: 'Too low', color: '#78909c' },
  normal: { label: 'Good', color: '#2e7d32' },
  high: { label: 'High', color: '#ef6c00' },
  flood: { label: 'Flood', color: '#c62828' },
};

export type Trend = 'rising' | 'falling' | 'steady';
/** Compare the latest value with ~3 hours earlier. */
export function trendOf(g: Gauge, param: GaugeParam): Trend | undefined {
  const s = g.series?.[param];
  if (!s || s.length < 2) return undefined;
  const [tEnd, vEnd] = s[s.length - 1];
  const earlier = [...s].reverse().find(([t]) => tEnd - t >= 3 * 3_600_000);
  if (!earlier) return undefined;
  const change = (vEnd - earlier[1]) / Math.max(Math.abs(earlier[1]), 0.01);
  return change > 0.05 ? 'rising' : change < -0.05 ? 'falling' : 'steady';
}
const TREND_ICON: Record<Trend, string> = { rising: '↗', falling: '↘', steady: '→' };

// ---------- formatting ----------
export function fmtValue(param: GaugeParam, v: number): string {
  const digits = param === '00060' ? (v >= 100 ? 0 : 1) : 2;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: digits })} ${GAUGE_PARAMS[param].unit}`;
}

function fmtAge(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  const clock = new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (mins < 60) return `${clock} (${Math.max(mins, 0)} min ago)`;
  if (mins < 24 * 60) return `${clock} (${Math.round(mins / 60)} h ago)`;
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** "57 cfs ↘ · Good" for route popups and lists. */
export function routeConditions(r: Route): { html: string; text: string } | null {
  const rg = routeGauge(r);
  if (!rg) return null;
  const param = r.levels?.param ?? (rg.gauge.latest['00060'] ? '00060' : '00065');
  const reading = rg.gauge.latest[param];
  if (!reading) return null;
  const trend = trendOf(rg.gauge, param);
  const level = levelFor(r.levels, reading.value);
  const lvl = level ? LEVEL_LABELS[level] : undefined;
  const text = `${fmtValue(param, reading.value)}${trend ? ` ${TREND_ICON[trend]}` : ''}${lvl ? ` · ${lvl.label}` : ''}`;
  const html = `🌊 <strong>${escapeHtml(text)}</strong>${lvl ? ` <span class="level-dot" style="background:${lvl.color}"></span>` : ''}
    <small>${rg.chosen ? '' : '(nearest gauge) '}${escapeHtml(rg.gauge.name)} · ${escapeHtml(fmtAge(reading.time))}</small>`;
  return { html, text };
}

/** Text for an observation's gauge field: "57 cfs · 3.8 ft at North Oconee River… (3:00 PM)". */
export function readingSummary(g: Gauge): string {
  const parts = PARAMS.filter((p) => g.latest[p]).map((p) => fmtValue(p, g.latest[p]!.value));
  const time = g.latest['00060']?.time ?? g.latest['00065']?.time;
  const clock = time ? new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return `${parts.join(' · ')} at ${g.name}${clock ? ` (${clock})` : ''}`;
}

// ---------- map layer ----------
/** Colour a gauge by the level of a route that uses it, if any. */
function gaugeLevel(g: Gauge): WaterLevel | undefined {
  for (const r of state.routes) {
    if (r.gaugeId !== g.id || !r.levels) continue;
    return levelFor(r.levels, g.latest[r.levels.param]?.value);
  }
  return undefined;
}

function sparkline(points: [number, number][], param: GaugeParam): string {
  if (points.length < 2) return '';
  const w = 240;
  const h = 70;
  const ts = points.map((p) => p[0]);
  const vs = points.map((p) => p[1]);
  const [t0, t1] = [Math.min(...ts), Math.max(...ts)];
  const [v0, v1] = [Math.min(...vs), Math.max(...vs)];
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v: number) => h - 4 - ((v - v0) / Math.max(1e-9, v1 - v0)) * (h - 8);
  const d = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="7-day ${GAUGE_PARAMS[param].label.toLowerCase()}">
      <path d="${d}" fill="none" stroke="#1565c0" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="spark-axis"><span>7 days ago</span><span>${escapeHtml(fmtValue(param, v0))} – ${escapeHtml(fmtValue(param, v1))}</span><span>now</span></div>`;
}

function popupHtml(g: Gauge, loading = false): string {
  const rows = PARAMS.filter((p) => g.latest[p])
    .map((p) => {
      const r = g.latest[p]!;
      const tr = trendOf(g, p);
      return `<div class="gauge-row"><span>${GAUGE_PARAMS[p].label}</span><strong>${escapeHtml(fmtValue(p, r.value))}</strong>${
        tr ? ` <span class="trend">${TREND_ICON[tr]} ${tr}</span>` : ''
      }</div>`;
    })
    .join('');
  const time = g.latest['00060']?.time ?? g.latest['00065']?.time;
  const chartParam: GaugeParam = g.series?.['00060']?.length ? '00060' : '00065';
  const chart = g.series?.[chartParam] ? sparkline(g.series[chartParam]!, chartParam) : '';
  const users = state.routes
    .filter((r) => r.gaugeId === g.id)
    .map((r) => {
      const lvl = levelFor(r.levels, r.levels ? g.latest[r.levels.param]?.value : undefined);
      return `${escapeHtml(r.name)}${lvl ? ` (<span style="color:${LEVEL_LABELS[lvl].color}">${LEVEL_LABELS[lvl].label}</span>)` : ''}`;
    });
  const stale = !navigator.onLine || Date.now() - Date.parse(g.latestFetchedAt) > LATEST_TTL;
  return `<div class="popup gauge-popup">
    <strong>${escapeHtml(g.name)}</strong>
    <div class="popup-meta">USGS gauge ${escapeHtml(g.id.replace(/^USGS-/, ''))}</div>
    ${rows}
    ${time ? `<div class="popup-updated">${stale ? 'Last reading: ' : 'As of '}${escapeHtml(fmtAge(time))}${!navigator.onLine ? ' · offline' : ''}</div>` : ''}
    ${chart || (loading ? '<div class="popup-updated">Loading 7-day history…</div>' : '')}
    ${users.length ? `<div class="popup-updated">Used by: ${users.join(', ')}</div>` : ''}
    <a href="https://waterdata.usgs.gov/monitoring-location/${encodeURIComponent(g.id)}/" target="_blank" rel="noopener">USGS page ↗</a>
  </div>`;
}

function upsertMarker(g: Gauge) {
  const param: GaugeParam = g.latest['00060'] ? '00060' : '00065';
  const reading = g.latest[param];
  const level = gaugeLevel(g);
  const color = level ? LEVEL_LABELS[level].color : '#1565c0';
  const value = reading ? fmtValue(param, reading.value).split(' ')[0] : '?';
  const icon = L.divIcon({
    className: '',
    html: `<div class="gauge-pin" style="--g:${color}"><b>${escapeHtml(value)}</b><small>${GAUGE_PARAMS[param].unit}</small></div>`,
    iconSize: [46, 30],
    iconAnchor: [23, 15],
  });
  let m = markers.get(g.id);
  if (!m) {
    m = L.marker([g.lat, g.lng], { icon, keyboard: false });
    m.on('click', async () => {
      if (getMode() !== 'idle') return;
      const cur = findGauge(g.id)!;
      const popup = L.popup({ maxWidth: 280 }).setLatLng([cur.lat, cur.lng]).setContent(popupHtml(cur, navigator.onLine)).openOn(map);
      if (!navigator.onLine) return;
      try {
        await fetchSeries(cur);
      } catch {
        /* keep the popup without a chart */
      }
      if (map.hasLayer(popup)) popup.setContent(popupHtml(findGauge(g.id)!));
    });
    markers.set(g.id, m);
    layer.addLayer(m);
  }
  m.setLatLng([g.lat, g.lng]).setIcon(icon);
}

export function renderGauges() {
  // A route's chosen gauge stays visible even if it has gone quiet.
  const chosen = new Set(state.routes.map((r) => r.gaugeId).filter(Boolean));
  for (const g of state.gauges) {
    if (isActive(g) || chosen.has(g.id)) upsertMarker(g);
    else {
      const m = markers.get(g.id);
      if (m) layer.removeLayer(m);
      markers.delete(g.id);
    }
  }
}

export function initGauges() {
  layersControl.addOverlay(layer, 'USGS gauges');
  if (prefs.get('gaugesOverlay') !== 'off') layer.addTo(map);
  map.on('overlayadd', (e: L.LayersControlEvent) => {
    if (e.layer !== layer) return;
    prefs.set('gaugesOverlay', 'on');
    void refreshView().then(renderGauges).catch(() => {});
  });
  map.on('overlayremove', (e: L.LayersControlEvent) => e.layer === layer && prefs.set('gaugesOverlay', 'off'));

  let timer = 0;
  map.on('moveend', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (navigator.onLine) void refreshView().then(renderGauges).catch(() => {});
    }, 1500);
  });
  window.addEventListener('online', () => void refreshGauges());
  // Keep readings current while the app is open.
  setInterval(() => document.visibilityState === 'visible' && void refreshGauges(), LATEST_TTL);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refreshGauges());
}
