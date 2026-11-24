import L from 'leaflet';
import { map } from './map';
import { state } from './state';
import { prefs, $, escapeHtml, fmtMi } from './ui';
import { KM_PER_MI, lengthKm, locateOnLine } from './geo';
import { accessOn } from './access';
import { MAIN, pathBetween, type RoutePlace } from './routeGraph';
import { offlineAreas } from './state';
import { isRecording, onRecordedFix, startRecording, stopRecording } from './tracks';
import { ensureWatching, onPosition } from './myLocation';
import { CATEGORIES, PATH_KINDS, type LatLng, type Route, type TripInfo } from './types';

/**
 * Trips: pick a put-in and take-out on a route (any of its access points, or
 * the ends of the route and its side branches) and paddle just that section.
 * The section is highlighted, a GPS track can be recorded with it, and a
 * banner shows progress: distance done and to go, an arrival estimate at your
 * pace, and what's coming up.
 */
interface Endpoint {
  label: string;
  place: RoutePlace;
  riverKm: number;
}

interface ActiveTrip extends TripInfo {
  startedAt: number;
  recording: boolean;
}

const KEY = 'activeTrip';
/** Hazards and features this close to the section count as "ahead". */
const AHEAD_NEAR_KM = 0.3;
/** Pace is worked out over this much recent time. */
const PACE_WINDOW_MS = 15 * 60_000;

let active: ActiveTrip | null = null;
const highlight = L.layerGroup();
/** Recent progress samples: [time, km along the section]. */
let samples: [number, number][] = [];
let dialogRoute: Route | null = null;
let endpoints: Endpoint[] = [];

const dialog = () => $<HTMLDialogElement>('trip-dialog');
const sel = (id: string) => $<HTMLSelectElement>(id);

// ---------- choosing put-in and take-out ----------
function endpointsOf(r: Route): Endpoint[] {
  const out: Endpoint[] = accessOn(r).map((a) => ({ label: a.point.name, place: a.place, riverKm: a.riverKm }));
  const mainKm = lengthKm(r.coords);
  const near = (km: number) => out.some((e) => e.place.branch === MAIN && Math.abs(e.place.km - km) < 0.15);
  if (!near(0)) out.push({ label: 'Start of the route', place: { branch: MAIN, km: 0 }, riverKm: 0 });
  if (!near(mainKm)) out.push({ label: 'End of the route', place: { branch: MAIN, km: mainKm }, riverKm: mainKm });
  for (const f of r.forks ?? []) {
    if (f.rejoin != null) continue;
    const len = lengthKm(f.coords);
    if (!out.some((e) => e.place.branch === f.id && Math.abs(e.place.km - len) < 0.15)) {
      out.push({ label: `End of ${f.name || 'the side branch'}`, place: { branch: f.id, km: len }, riverKm: f.from + len });
    }
  }
  return out.sort((a, b) => a.riverKm - b.riverKm);
}

function section(): { coords: LatLng[]; km: number; forks: string[] } | null {
  if (!dialogRoute) return null;
  const a = endpoints[Number(sel('trip-from').value)];
  const b = endpoints[Number(sel('trip-to').value)];
  if (!a || !b || a === b) return null;
  return pathBetween(dialogRoute, a.place, b.place);
}

/** Is the section within the route's saved offline areas? */
function savedOffline(r: Route, coords: LatLng[]): boolean {
  const areas = offlineAreas(r);
  if (!areas.length) return false;
  const step = Math.max(1, Math.floor(coords.length / 40));
  for (let i = 0; i < coords.length; i += step) {
    const ok = areas.some((a) => (locateOnLine(a.coords, coords[i])?.offKm ?? Infinity) <= a.bufferKm * 0.8);
    if (!ok) return false;
  }
  return true;
}

function updateSummary() {
  const s = section();
  const r = dialogRoute!;
  $<HTMLButtonElement>('trip-start').disabled = !s;
  if (!s) {
    $('trip-summary').textContent = 'Pick two different places.';
    $('trip-offline').hidden = true;
    return;
  }
  const via = s.forks
    .map((id) => r.forks?.find((f) => f.id === id))
    .filter(Boolean)
    .map((f) => f!.name || (f!.rejoin != null ? 'a channel' : 'a side branch'));
  $('trip-summary').textContent = `${fmtMi(s.km / KM_PER_MI)}${via.length ? ` · via ${via.join(', ')}` : ''}`;
  $('trip-offline').hidden = savedOffline(r, s.coords);
}

export function openTripDialog(r: Route) {
  if (active) {
    alert('A trip is already going. End it first (from the trip banner).');
    return;
  }
  dialogRoute = r;
  endpoints = endpointsOf(r);
  const options = endpoints.map((e, i) => `<option value="${i}">${escapeHtml(e.label)} · mile ${(e.riverKm / KM_PER_MI).toFixed(1)}</option>`).join('');
  sel('trip-from').innerHTML = options;
  sel('trip-to').innerHTML = options;
  // Default: the first access point to the last.
  sel('trip-from').value = '0';
  sel('trip-to').value = String(endpoints.length - 1);
  $('trip-title').textContent = `Start a trip on “${r.name}”`;
  map.closePopup();
  updateSummary();
  dialog().showModal();
}

// ---------- the trip itself ----------
function save() {
  prefs.set(KEY, active ? JSON.stringify(active) : '');
}

function drawHighlight() {
  highlight.clearLayers();
  if (!active) return;
  L.polyline(active.coords, { color: '#ffd54f', weight: 14, opacity: 0.55, interactive: false, lineCap: 'round' }).addTo(highlight);
  const flag = (at: LatLng, color: string, label: string) =>
    L.circleMarker(at, { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
      .bindTooltip(label, { direction: 'top' })
      .addTo(highlight);
  flag(active.coords[0], '#2e7d32', `Put-in: ${active.from}`);
  flag(active.coords[active.coords.length - 1], '#c62828', `Take-out: ${active.to}`);
  highlight.addTo(map);
  // Under the route lines and markers.
  highlight.eachLayer((l) => (l as L.Path).bringToBack?.());
}

/** What's coming up after `km` along the section. */
function ahead(km: number): string {
  if (!active) return '';
  const coords = active.coords;
  const items: { km: number; text: string }[] = [];
  for (const p of state.points) {
    if (!['hazard', 'rapid', 'access', 'bridge'].includes(p.category)) continue;
    const loc = locateOnLine(coords, [p.lat, p.lng]);
    if (!loc || loc.offKm > AHEAD_NEAR_KM || loc.alongKm <= km + 0.02) continue;
    items.push({ km: loc.alongKm, text: `${CATEGORIES[p.category].icon} ${p.name}` });
  }
  for (const pg of state.portages) {
    const loc = locateOnLine(coords, pg.coords[0]);
    if (!loc || loc.offKm > AHEAD_NEAR_KM || loc.alongKm <= km + 0.02) continue;
    items.push({ km: loc.alongKm, text: `${PATH_KINDS[pg.kind].icon} ${pg.name}` });
  }
  items.sort((a, b) => a.km - b.km);
  return items
    .slice(0, 2)
    .map((x) => `${escapeHtml(x.text)} in ${fmtMi((x.km - km) / KM_PER_MI)}`)
    .join(' · ');
}

function render(at?: LatLng, time = Date.now()) {
  const banner = $('trip-banner');
  banner.hidden = !active;
  document.body.classList.toggle('trip-on', !!active);
  if (!active) return;
  let doneKm: number | null = null;
  if (at) {
    const loc = locateOnLine(active.coords, at);
    if (loc && loc.offKm <= 1) {
      doneKm = loc.alongKm;
      samples.push([time, doneKm]);
      samples = samples.filter(([t]) => t >= time - PACE_WINDOW_MS);
    }
  } else if (samples.length) doneKm = samples[samples.length - 1][1];
  const total = active.km;
  const parts = [`<strong>${escapeHtml(active.from)} → ${escapeHtml(active.to)}</strong>`];
  if (doneKm == null) {
    parts.push(`${fmtMi(total / KM_PER_MI)} · waiting for your position…`);
  } else {
    const left = Math.max(0, total - doneKm);
    parts.push(`${fmtMi(doneKm / KM_PER_MI)} of ${fmtMi(total / KM_PER_MI)}`);
    // Pace over the last 15 minutes (needs at least a couple of minutes of movement).
    const first = samples[0];
    const last = samples[samples.length - 1];
    const hours = (last[0] - first[0]) / 3_600_000;
    const kmh = hours >= 2 / 60 ? (last[1] - first[1]) / hours : 0;
    if (left < 0.05) parts.push('at the take-out');
    else if (kmh > 0.5) {
      const eta = new Date(time + (left / kmh) * 3_600_000);
      parts.push(`${(kmh / KM_PER_MI).toFixed(1)} mph · arrive ~${eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    }
    const next = ahead(doneKm);
    if (next) parts.push(`Next: ${next}`);
  }
  $('trip-text').innerHTML = (active.recording && isRecording() ? '<span class="rec-dot">●</span> ' : '') + parts.join(' · ');
}

async function start() {
  const r = dialogRoute;
  const s = section();
  if (!r || !s) return;
  const from = endpoints[Number(sel('trip-from').value)];
  const to = endpoints[Number(sel('trip-to').value)];
  const record = $<HTMLInputElement>('trip-record').checked;
  const info: TripInfo = { routeId: r.id, from: from.label, to: to.label, coords: s.coords, km: s.km };
  dialog().close();
  if (record && !isRecording()) {
    const ok = await startRecording({ name: `${r.name}: ${from.label} → ${to.label}`, trip: info });
    if (!ok) return;
  }
  active = { ...info, startedAt: Date.now(), recording: record };
  samples = [];
  save();
  ensureWatching();
  drawHighlight();
  render();
  map.fitBounds(L.latLngBounds(s.coords), { padding: [40, 40] });
}

async function end() {
  if (!active) return;
  const wasRecording = active.recording && isRecording();
  if (!confirm(wasRecording ? 'End the trip? This also stops recording your GPS track.' : 'End the trip?')) return;
  const track = wasRecording ? await stopRecording() : undefined;
  active = null;
  samples = [];
  save();
  highlight.clearLayers();
  highlight.remove();
  render();
  if (track && confirm('Trip ended. Make a trip report now?')) {
    const { openReportDialog } = await import('./reportDialog');
    openReportDialog({ track });
  }
}

export function initTrips() {
  $('trip-from').addEventListener('change', updateSummary);
  $('trip-to').addEventListener('change', updateSummary);
  $('trip-swap').addEventListener('click', () => {
    const a = sel('trip-from').value;
    sel('trip-from').value = sel('trip-to').value;
    sel('trip-to').value = a;
    updateSummary();
  });
  $('trip-cancel').addEventListener('click', () => dialog().close());
  $('trip-start').addEventListener('click', () => void start());
  $('trip-offline-save').addEventListener('click', async () => {
    const r = dialogRoute;
    const s = section();
    if (!r || !s) return;
    dialog().close();
    const { openOffline } = await import('./routes');
    openOffline(r, { coords: s.coords, label: 'this trip section' });
  });
  $('trip-end').addEventListener('click', () => void end());
  $('trip-banner').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('#trip-end') || !active) return;
    map.fitBounds(L.latLngBounds(active.coords), { padding: [40, 40] });
  });

  // Progress from the track being recorded (works in the background) and from the live location.
  onRecordedFix((lat, lng, time) => active && render([lat, lng], time));
  onPosition((lat, lng, time) => active && render([lat, lng], time));

  // A trip still going from before the app was closed.
  try {
    const saved = JSON.parse(prefs.get(KEY) || 'null') as ActiveTrip | null;
    if (saved && state.routes.some((r) => r.id === saved.routeId)) {
      active = saved;
      ensureWatching();
      drawHighlight();
      render();
    }
  } catch {
    /* ignore */
  }
  // Keep "arrive ~" fresh even when standing still.
  setInterval(() => active && render(), 30_000);
}
