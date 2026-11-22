import { Capacitor, registerPlugin } from '@capacitor/core';
import { importFiles, toast } from './photos';
import { isNative } from './platform';
import { $, prefs } from './ui';

/**
 * Photo sessions (Android app): shoot with the phone's own camera app, with its
 * panorama, zoom and night modes, and photos saved to the camera roll as usual.
 * Every photo taken since the session started is pulled into River Guide each
 * time you switch back to it, located from its own GPS tag, a recorded track,
 * or the phone's current position.
 */
interface RollPhoto {
  id: string;
  name: string;
  takenAt: number;
  width: number;
  height: number;
  mime?: string;
}
interface CameraRollPlugin {
  requestAccess(): Promise<{ photos: boolean; location: boolean }>;
  openCamera(): Promise<void>;
  listSince(opts: { since: number }): Promise<{ photos: RollPhoto[] }>;
  copyToCache(opts: { id: string }): Promise<{ path: string }>;
  clearCache(): Promise<void>;
}
const CameraRoll = registerPlugin<CameraRollPlugin>('CameraRoll');

interface Session {
  /** Epoch ms; photos taken from here on are imported. */
  start: number;
  /** Camera-roll IDs already imported (or skipped), so nothing comes in twice. */
  seen: string[];
  imported: number;
}

const KEY = 'photoSession';
/** A session left running this long is ended automatically. */
const MAX_AGE = 24 * 3600_000;

function load(): Session | null {
  try {
    const s = JSON.parse(prefs.get(KEY) ?? 'null');
    return s && typeof s.start === 'number' && Array.isArray(s.seen) ? s : null;
  } catch {
    return null;
  }
}
const save = (s: Session | null) => prefs.set(KEY, s ? JSON.stringify(s) : 'null');

function renderBanner() {
  const s = load();
  $('photo-session').hidden = !s;
  document.body.classList.toggle('photo-session-on', !!s);
  if (!s) return;
  const since = new Date(s.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('photo-session-text').textContent = `Photo session · ${s.imported}`;
  $('photo-session').title = `Photo session since ${since}: ${s.imported} photo${s.imported === 1 ? '' : 's'} added`;
}

function currentFix() {
  return new Promise<{ lat: number; lng: number; time: number } | undefined>((resolve) => {
    if (!('geolocation' in navigator)) return resolve(undefined);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, time: pos.timestamp }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}

let syncing: Promise<void> | null = null;

/** Import any new camera-roll photos from the running session. */
export function syncSession(): Promise<void> {
  syncing ??= doSync().finally(() => (syncing = null));
  return syncing;
}

async function doSync() {
  const s = load();
  if (!s) return;
  let list: RollPhoto[];
  try {
    ({ photos: list } = await CameraRoll.listSince({ since: s.start }));
  } catch (err) {
    toast(`Couldn't check the camera roll: ${(err as Error).message}`);
    return;
  }
  const fresh = list.filter((r) => !s.seen.includes(r.id) && (!r.mime || r.mime.startsWith('image/')));
  if (!fresh.length) return;
  toast(`Adding ${fresh.length} photo${fresh.length === 1 ? '' : 's'} from your camera…`, 60_000);
  // Used only for photos taken in the last couple of minutes that have no GPS tag of their own.
  const fix = await currentFix();
  let added = 0;
  let located = 0;
  let failed = 0;
  for (const r of fresh) {
    try {
      const { path } = await CameraRoll.copyToCache({ id: r.id });
      const blob = await (await fetch(Capacitor.convertFileSrc(path))).blob();
      const file = new File([blob], r.name || `${r.id}.jpg`, { type: r.mime || 'image/jpeg', lastModified: r.takenAt });
      const [p] = await importFiles([file], { fix, quiet: true });
      if (p) {
        added++;
        if (p.lat != null) located++;
      } else failed++;
    } catch {
      failed++;
    }
    s.seen.push(r.id);
    save(s); // remember progress in case the app is closed mid-import
  }
  s.imported += added;
  save(s);
  void CameraRoll.clearCache().catch(() => {});
  renderBanner();
  const parts = [
    `Added ${added} photo${added === 1 ? '' : 's'}: ${located} located`,
    added - located > 0 && `${added - located} need placing`,
    failed > 0 && `${failed} couldn't be read`,
  ].filter(Boolean);
  toast(`${parts.join(', ')}. <button class="link" data-open-review>Review</button>`, 10_000);
}

async function start() {
  const access = await CameraRoll.requestAccess().catch(() => ({ photos: false, location: false }));
  if (!access.photos) {
    alert('River Guide needs access to all your photos to pick up the pictures you take (choose “Allow all”, since limited access hides new photos). You can change it in Settings › Apps › River Guide › Permissions › Photos and videos.');
    return;
  }
  if (!access.location) {
    toast("Photo locations can't be read without the “photo location” permission. River Guide will use your track or current position instead.", 10_000);
  }
  // A few seconds of slack so a photo taken right as the session starts isn't missed.
  save({ start: Date.now() - 5000, seen: [], imported: 0 });
  renderBanner();
  await openCamera();
}

async function openCamera() {
  try {
    await CameraRoll.openCamera();
  } catch (err) {
    alert(`Couldn't open the camera: ${(err as Error).message}`);
  }
}

async function end() {
  await syncSession();
  const s = load();
  save(null);
  renderBanner();
  if (s) toast(`Photo session ended · ${s.imported} photo${s.imported === 1 ? '' : 's'} added.`);
}

/** Native only: the camera button starts (or returns to) a photo session. Call syncSession() once data has loaded. */
export function initCameraRoll(): boolean {
  if (!isNative) return false;
  const s = load();
  if (s && Date.now() - s.start > MAX_AGE) save(null);
  renderBanner();

  const btn = $('photo-here');
  btn.title = 'Photo session: shoot with your camera app (panoramas too)';
  btn.setAttribute('aria-label', 'Start a photo session');
  btn.addEventListener('click', () => {
    if (load()) void openCamera();
    else void start();
  });
  $('photo-session-camera').addEventListener('click', () => void openCamera());
  $('photo-session-end').addEventListener('click', () => void end());

  // Coming back from the camera app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncSession();
  });
  return true;
}
