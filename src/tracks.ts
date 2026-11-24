import L from 'leaflet';
import { registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import { layersControl, map } from './map';
import { state } from './state';
import { del, put, putMany } from './store';
import { distKm, lengthMi, simplify } from './geo';
import { isNative, saveFile } from './platform';
import { createRoute } from './routes';
import { closeSidebarOnMobile } from './points';
import type { LatLng, Track, TrackFix } from './types';
import { $, escapeHtml, fmtMi, getMode, prefs } from './ui';

const TRACK_COLOR = '#e65100';
/** Fixes less accurate than this are dropped (metres). */
const MAX_ACCURACY_M = 50;
/** Skip a fix closer than this to the previous one unless a minute has passed (metres). */
const MIN_STEP_M = 8;
/** Photo times this far from any fix aren't matched (seconds). */
const MAX_MATCH_GAP_S = 600;

const trackLayer = L.layerGroup();
const lines = new Map<string, L.Polyline>();
const findTrack = (id: string) => state.tracks.find((t) => t.id === id);
const fixesToLatLng = (fixes: TrackFix[]): LatLng[] => fixes.map(([lat, lng]) => [lat, lng]);

// ---------- formatting ----------
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
const trackSpan = (t: Track) => (t.fixes.length ? t.fixes[t.fixes.length - 1][2] - t.fixes[0][2] : 0);
const trackDate = (t: Track) => new Date(t.fixes[0]?.[2] ?? t.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// ---------- rendering ----------
function popupHtml(t: Track) {
  return `<div class="popup">
    <strong>${escapeHtml(t.name)}</strong>
    <div class="popup-meta">${trackDate(t)} · ${fmtMi(lengthMi(fixesToLatLng(t.fixes)))} · ${fmtDuration(trackSpan(t))}</div>
    <div class="popup-actions">
      <button class="btn small" data-track-action="rename" data-id="${t.id}">Rename</button>
      <button class="btn small" data-track-action="route" data-id="${t.id}">Make route</button>
      <button class="btn small" data-track-action="report" data-id="${t.id}">Trip report</button>
      <button class="btn small" data-track-action="gpx" data-id="${t.id}">Export GPX</button>
      <button class="btn small danger" data-track-action="delete" data-id="${t.id}">Delete</button>
    </div>
  </div>`;
}

function upsertLine(t: Track) {
  let line = lines.get(t.id);
  if (!line) {
    line = L.polyline([], { color: TRACK_COLOR, weight: 3, opacity: 0.85 });
    line.on('click', (e: L.LeafletMouseEvent) => {
      const cur = findTrack(t.id);
      if (cur && getMode() === 'idle') L.popup({ maxWidth: 300 }).setLatLng(e.latlng).setContent(popupHtml(cur)).openOn(map);
    });
    lines.set(t.id, line);
    trackLayer.addLayer(line);
  }
  line.setLatLngs(fixesToLatLng(t.fixes));
}

export function renderTracks() {
  for (const t of state.tracks) upsertLine(t);
  for (const [id, line] of lines) {
    if (!findTrack(id)) {
      trackLayer.removeLayer(line);
      lines.delete(id);
    }
  }
  const sorted = [...state.tracks].sort((a, b) => (b.fixes[0]?.[2] ?? 0) - (a.fixes[0]?.[2] ?? 0));
  $('track-list').innerHTML = sorted.length
    ? sorted
        .map(
          (t) => `<li data-id="${t.id}">
            <span class="swatch" style="background:${TRACK_COLOR}"></span>
            <span class="li-text"><strong>${escapeHtml(t.name)}${t.recording ? ' <em class="rec-dot">●</em>' : ''}</strong>
              <small>${trackDate(t)} · ${fmtMi(lengthMi(fixesToLatLng(t.fixes)))} · ${fmtDuration(trackSpan(t))}</small></span>
          </li>`,
        )
        .join('')
    : `<li class="empty">No tracks yet. Record one on your next trip, or import a GPX file.</li>`;
}

async function saveTrack(t: Track) {
  t.updatedAt = new Date().toISOString();
  await put('tracks', t);
  if (!findTrack(t.id)) state.tracks.push(t);
  renderTracks();
}

// ---------- recording ----------
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

interface Recorder {
  track: Track;
  stop: () => Promise<void>;
  unsaved: number;
  lastSave: number;
  timer: number;
}
let recorder: Recorder | null = null;
export const isRecording = () => recorder !== null;

function addFix(lat: number, lng: number, time: number, accuracy: number | null) {
  const r = recorder;
  if (!r) return;
  if (accuracy != null && accuracy > MAX_ACCURACY_M) return;
  const last = r.track.fixes[r.track.fixes.length - 1];
  if (last && distKm([last[0], last[1]], [lat, lng]) * 1000 < MIN_STEP_M && time - last[2] < 60_000) return;
  r.track.fixes.push([+lat.toFixed(6), +lng.toFixed(6), time, accuracy == null ? -1 : Math.round(accuracy)]);
  r.unsaved++;
  upsertLine(r.track);
  updateBanner();
  // Save in batches; callbacks keep arriving in the background, timers may not.
  if (r.unsaved >= 10 || Date.now() - r.lastSave > 30_000) void flush();
}

async function flush() {
  const r = recorder;
  if (!r || !r.unsaved) return;
  r.unsaved = 0;
  r.lastSave = Date.now();
  await put('tracks', r.track);
  renderTracks();
}

async function startNative(): Promise<() => Promise<void>> {
  // Android 13+ needs notification permission for the "recording" notification.
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.requestPermissions();
  } catch {
    /* tracking still works without the notification permission on older Android */
  }
  const id = await BackgroundGeolocation.addWatcher(
    {
      backgroundTitle: 'River Guide is recording your track',
      backgroundMessage: 'Open the app and tap Stop when you finish.',
      requestPermissions: true,
      stale: false,
      distanceFilter: MIN_STEP_M,
    },
    (loc, err) => {
      if (err) {
        if (err.code === 'NOT_AUTHORIZED' && confirm('River Guide needs location access to record tracks. Open settings?')) {
          void BackgroundGeolocation.openSettings();
        }
        return;
      }
      if (loc) addFix(loc.latitude, loc.longitude, loc.time ?? Date.now(), loc.accuracy);
    },
  );
  return () => BackgroundGeolocation.removeWatcher({ id });
}

async function startWeb(): Promise<() => Promise<void>> {
  if (!('geolocation' in navigator)) throw new Error('This browser has no location access.');
  // The browser stops sending locations when the screen sleeps, so keep it awake.
  let lock: WakeLockSentinel | null = null;
  const acquire = async () => {
    try {
      lock = await navigator.wakeLock?.request('screen');
    } catch {
      /* not supported or denied */
    }
  };
  const onVisible = () => document.visibilityState === 'visible' && void acquire();
  document.addEventListener('visibilitychange', onVisible);
  await acquire();
  const watchId = navigator.geolocation.watchPosition(
    (p) => addFix(p.coords.latitude, p.coords.longitude, p.timestamp, p.coords.accuracy),
    (e) => console.warn('geolocation', e.message),
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
  return async () => {
    navigator.geolocation.clearWatch(watchId);
    document.removeEventListener('visibilitychange', onVisible);
    await lock?.release();
  };
}

async function startRecording() {
  if (recorder) return;
  const now = new Date();
  const track: Track = {
    id: crypto.randomUUID(),
    name: `Trip ${now.toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
    fixes: [],
    source: 'recorded',
    recording: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  recorder = { track, stop: async () => {}, unsaved: 0, lastSave: Date.now(), timer: 0 };
  try {
    recorder.stop = isNative ? await startNative() : await startWeb();
  } catch (err) {
    recorder = null;
    alert(`Couldn't start recording: ${(err as Error).message}`);
    return;
  }
  await saveTrack(track);
  recorder.timer = window.setInterval(updateBanner, 1000);
  updateBanner();
  if (!isNative) {
    $('rec-note').hidden = false;
  }
}

async function stopRecording() {
  const r = recorder;
  if (!r) return;
  await r.stop();
  clearInterval(r.timer);
  recorder = null;
  r.track.recording = false;
  if (r.track.fixes.length < 2) {
    await del('tracks', r.track.id);
    state.tracks = state.tracks.filter((t) => t.id !== r.track.id);
    alert('No movement was recorded, so the track was discarded.');
  } else {
    await saveTrack(r.track);
  }
  renderTracks();
  updateBanner();
  document.dispatchEvent(new CustomEvent('tracks-changed'));
}

function updateBanner() {
  const r = recorder;
  $('rec-banner').hidden = !r;
  $('record-toggle').textContent = r ? '■ Stop recording' : '● Record track';
  $('record-toggle').classList.toggle('danger', !!r);
  document.body.classList.toggle('recording', !!r);
  if (!r) {
    $('rec-note').hidden = true;
    return;
  }
  const started = r.track.fixes[0]?.[2] ?? Date.parse(r.track.createdAt);
  $('rec-stats').textContent = `${fmtDuration(Date.now() - started)} · ${fmtMi(lengthMi(fixesToLatLng(r.track.fixes)))}`;
}

// ---------- photo matching ----------
/** Where was I at `time`? Interpolates between the surrounding fixes of any track. */
export function positionAt(time: number): { lat: number; lng: number; gapSec: number } | null {
  let best: { lat: number; lng: number; gapSec: number } | null = null;
  for (const t of state.tracks) {
    const f = t.fixes;
    if (f.length < 1 || time < f[0][2] - MAX_MATCH_GAP_S * 1000 || time > f[f.length - 1][2] + MAX_MATCH_GAP_S * 1000) continue;
    let lo = 0;
    let hi = f.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (f[mid][2] <= time) lo = mid;
      else hi = mid;
    }
    let cand: { lat: number; lng: number; gapSec: number };
    if (time <= f[0][2]) cand = { lat: f[0][0], lng: f[0][1], gapSec: (f[0][2] - time) / 1000 };
    else if (time >= f[f.length - 1][2]) {
      const e = f[f.length - 1];
      cand = { lat: e[0], lng: e[1], gapSec: (time - e[2]) / 1000 };
    } else {
      const [a, b] = [f[lo], f[hi]];
      const k = (time - a[2]) / Math.max(1, b[2] - a[2]);
      cand = {
        lat: a[0] + (b[0] - a[0]) * k,
        lng: a[1] + (b[1] - a[1]) * k,
        gapSec: Math.min(time - a[2], b[2] - time) / 1000,
      };
    }
    if (cand.gapSec <= MAX_MATCH_GAP_S && (!best || cand.gapSec < best.gapSec)) best = cand;
  }
  return best;
}

// ---------- GPX ----------
function parseGpx(text: string, fileName: string): Track[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid GPX file');
  const out: Track[] = [];
  const now = new Date().toISOString();
  const groups = [...doc.querySelectorAll('trk')];
  const sources = groups.length ? groups : [...doc.querySelectorAll('rte')];
  for (const g of sources) {
    const fixes: TrackFix[] = [];
    for (const p of g.querySelectorAll('trkpt, rtept')) {
      const lat = Number(p.getAttribute('lat'));
      const lng = Number(p.getAttribute('lon'));
      const time = Date.parse(p.querySelector('time')?.textContent ?? '');
      if (Number.isFinite(lat) && Number.isFinite(lng)) fixes.push([lat, lng, Number.isFinite(time) ? time : 0, -1]);
    }
    if (fixes.length < 2) continue;
    const name = g.querySelector(':scope > name')?.textContent?.trim() || fileName.replace(/\.gpx$/i, '');
    out.push({ id: crypto.randomUUID(), name, fixes, source: 'gpx', createdAt: now, updatedAt: now });
  }
  if (!out.length) throw new Error('No track found in this GPX file');
  return out;
}

function toGpx(t: Track): string {
  const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const pts = t.fixes
    .map(([lat, lng, time]) => `      <trkpt lat="${lat}" lon="${lng}">${time ? `<time>${new Date(time).toISOString()}</time>` : ''}</trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="River Guide" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(t.name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

// ---------- wiring ----------
export function initTracks() {
  layersControl.addOverlay(trackLayer, 'My tracks');
  if (prefs.get('tracksOverlay') !== 'off') trackLayer.addTo(map);
  map.on('overlayadd', (e: L.LayersControlEvent) => e.layer === trackLayer && prefs.set('tracksOverlay', 'on'));
  map.on('overlayremove', (e: L.LayersControlEvent) => e.layer === trackLayer && prefs.set('tracksOverlay', 'off'));

  $('record-toggle').addEventListener('click', () => (recorder ? stopRecording() : startRecording()));
  $('rec-stop').addEventListener('click', () => stopRecording());

  $<HTMLInputElement>('import-gpx').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    let added: Track[] = [];
    for (const file of files) {
      try {
        added = added.concat(parseGpx(await file.text(), file.name));
      } catch (err) {
        alert(`${file.name}: ${(err as Error).message}`);
      }
    }
    if (!added.length) return;
    await putMany('tracks', added);
    state.tracks.push(...added);
    renderTracks();
    map.fitBounds(L.latLngBounds(added.flatMap((t) => fixesToLatLng(t.fixes))), { padding: [40, 40] });
    document.dispatchEvent(new CustomEvent('tracks-changed'));
  });

  $('track-list').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]')?.dataset.id;
    const t = id && findTrack(id);
    const line = id && lines.get(id);
    if (!t || !line) return;
    if (!map.hasLayer(trackLayer)) trackLayer.addTo(map);
    map.fitBounds(line.getBounds(), { padding: [40, 40] });
    L.popup({ maxWidth: 300 }).setLatLng(line.getCenter()).setContent(popupHtml(t)).openOn(map);
    closeSidebarOnMobile();
  });

  map.getContainer().addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-track-action]');
    const t = btn?.dataset.id ? findTrack(btn.dataset.id) : undefined;
    if (!btn || !t) return;
    switch (btn.dataset.trackAction) {
      case 'rename': {
        const name = prompt('Track name', t.name)?.trim();
        if (name) {
          t.name = name;
          await saveTrack(t);
          map.closePopup();
        }
        return;
      }
      case 'route': {
        map.closePopup();
        // ~15 m tolerance keeps river bends while dropping GPS jitter.
        await createRoute(simplify(fixesToLatLng(t.fixes), 15), t.name);
        return;
      }
      case 'report': {
        if (t.recording) return alert('Stop recording first, then make the trip report.');
        map.closePopup();
        const { exportTripReport, routeAlong } = await import('./tripReport');
        return exportTripReport({ track: t, route: routeAlong(t) }).catch((err) => alert(`Couldn't make the trip report: ${(err as Error).message}`));
      }
      case 'gpx':
        return saveFile(`${t.name.replace(/[^\w.-]+/g, '_')}.gpx`, toGpx(t), 'application/gpx+xml');
      case 'delete':
        if (t.recording) return alert('Stop recording before deleting this track.');
        if (!confirm(`Delete track “${t.name}”? Photos already placed are kept.`)) return;
        await del('tracks', t.id);
        state.tracks = state.tracks.filter((x) => x.id !== t.id);
        map.closePopup();
        renderTracks();
        document.dispatchEvent(new CustomEvent('tracks-changed'));
        return;
    }
  });
}

/** Load-time cleanup: a track left "recording" means the app was closed mid-trip. */
export async function finishInterruptedTracks() {
  for (const t of state.tracks) {
    if (!t.recording) continue;
    t.recording = false;
    if (!/\(interrupted\)$/.test(t.name)) t.name += ' (interrupted)';
    await put('tracks', t);
  }
}
