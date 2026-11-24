import L from 'leaflet';
import { map } from '../map';
import { cameraName, importFiles, toast } from '../photos';
import { state } from '../state';
import type { Photo } from '../types';
import { classify, type PickedItem, type TripWindow } from './pickerMatch';
import { askCredits, type CreditItem } from './creditDialog';
import { $, escapeHtml } from '../ui';
import { googleConfigured, SCOPES } from './config';
import { getToken, openExternal } from './googleAuth';
import { isNative } from '../platform';

/**
 * "Import from Google Photos": opens Google's photo picker, then imports the
 * chosen photos like any other (as drafts to review).
 *
 * Google removes location data from photos downloaded this way, so they're
 * located by matching their time to a recorded GPS track, or placed by hand.
 * https://developers.google.com/photos/picker
 */
const API = 'https://photospicker.googleapis.com/v1';

async function api(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API}/${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let msg = String(res.status);
    try {
      msg = (await res.json())?.error?.message ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(`Google Photos: ${msg}`);
  }
  return res.status === 204 ? null : res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** "5s" -> 5000 */
const dur = (s: string | undefined, fallback: number) => (s ? Math.round(parseFloat(s) * 1000) : fallback);

const cameraOf = (m: PickedItem) =>
  cameraName(m.mediaFile.mediaFileMetadata?.cameraMake, m.mediaFile.mediaFileMetadata?.cameraModel);

async function pickAndImport(win: Window | null, trip?: TripWindow) {
  // From a click: may show Google's sign-in/consent for the Photos permission.
  const token = await getToken([SCOPES.photosPicker], true);
  const session = await api('sessions', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  // "/autoclose" closes Google's picker window once you're done choosing.
  const url = `${session.pickerUri}/autoclose`;
  let opened = false;
  if (isNative) {
    // The app's WebView can't open windows: hand the link to Android (opens Google Photos).
    opened = await openExternal(url).then(
      () => true,
      () => false,
    );
  } else if (win && !win.closed) {
    win.location.href = url;
    opened = true;
  }
  const fmt = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const hint = trip
    ? `Pick freely: only photos taken during ${trip.label} (${fmt(trip.start)}) are kept, and ones already in River Guide are skipped.`
    : 'Pick freely: photos already in River Guide are skipped.';
  // If nothing could be opened automatically, a tap on this link always works.
  toast(
    `${opened ? 'Choose photos in Google Photos, then come back here.' : 'Open Google Photos to choose photos.'} ${escapeHtml(hint)} ` +
      `<a class="link" href="${url}" target="_blank" rel="noopener">${opened ? 'Reopen' : 'Open Google Photos'}</a>`,
    10 * 60_000,
  );

  // Wait for the selection to be made.
  const deadline = Date.now() + dur(session.pollingConfig?.timeoutIn, 10 * 60_000);
  let s = session;
  while (!s.mediaItemsSet) {
    if (Date.now() > deadline) {
      toast('Google Photos picker timed out.');
      return;
    }
    await sleep(Math.max(1500, dur(s.pollingConfig?.pollInterval, 3000)));
    s = await api(`sessions/${session.id}`, token);
  }

  // List what was picked, and work out what's actually new before downloading anything.
  const items: PickedItem[] = [];
  let page = '';
  do {
    const r = await api(`mediaItems?sessionId=${session.id}&pageSize=100${page ? `&pageToken=${page}` : ''}`, token);
    items.push(...(r.mediaItems ?? []));
    page = r.nextPageToken ?? '';
  } while (page);
  const { fresh, duplicates, outside, videos } = classify(items, state.photos, trip);

  // Who took them? Asked with the photos on screen, one camera at a time.
  const groups = new Map<string, CreditItem[]>();
  for (const m of fresh) {
    const c = cameraOf(m) ?? '';
    const thumb = async () => {
      const res = await fetch(`${m.mediaFile.baseUrl}=w240-h240-c`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(String(res.status));
      return URL.createObjectURL(await res.blob());
    };
    groups.set(c, [...(groups.get(c) ?? []), { id: m.id, thumb }]);
  }
  const credits = fresh.length ? await askCredits(groups) : new Map<string, string>();

  if (fresh.length) toast(`Importing ${fresh.length} photo${fresh.length === 1 ? '' : 's'} from Google Photos…`, 60_000);
  const files: File[] = [];
  const extras = new Map<File, Partial<Photo>>();
  for (const m of fresh) {
    // "=d" downloads the original (with its date/time; Google strips GPS).
    const res = await fetch(`${m.mediaFile.baseUrl}=d`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const file = new File([await res.blob()], m.mediaFile.filename ?? `${m.id}.jpg`, {
      type: m.mediaFile.mimeType ?? 'image/jpeg',
      lastModified: Date.parse(m.createTime) || Date.now(),
    });
    const camera = cameraOf(m);
    const credit = credits.get(m.id);
    extras.set(file, { googleId: m.id, ...(camera ? { camera } : {}), ...(credit ? { credit } : {}) });
    files.push(file);
  }
  await api(`sessions/${session.id}`, token, { method: 'DELETE' }).catch(() => {});

  const added = await importFiles(files, { extras });
  const located = added.filter((p) => p.lat != null);
  const parts = [
    `Imported ${added.length} photo${added.length === 1 ? '' : 's'}`,
    added.length > 0 && `${located.length} matched to a track, ${added.length - located.length} to place by hand`,
    duplicates > 0 && `${duplicates} already in River Guide`,
    outside > 0 && `${outside} not from this trip`,
    videos > 0 && `${videos} video${videos === 1 ? '' : 's'} skipped`,
  ].filter(Boolean);
  toast(`${parts.join(' · ')}.${added.length ? ' <button class="link" data-open-review>Review</button>' : ''}`, 15_000);
  if (located.length) map.fitBounds(L.latLngBounds(located.map((p) => L.latLng(p.lat!, p.lng!))), { padding: [60, 60], maxZoom: 16 });
}

let busy = false;
/**
 * Open the picker and import. With a trip, only photos taken during it are
 * kept. Call straight from a tap (browsers only allow new windows then).
 */
export function importFromGooglePhotos(trip?: TripWindow) {
  if (busy) return;
  busy = true;
  const btn = $<HTMLButtonElement>('import-google-photos');
  btn.disabled = true;
  // Open the window now and point it at Google's picker once the session exists.
  const win = isNative ? null : window.open('about:blank', '_blank');
  void pickAndImport(win, trip)
    .catch((err) => {
      win?.close();
      alert(`Couldn't import from Google Photos: ${(err as Error).message}`);
    })
    .finally(() => {
      busy = false;
      btn.disabled = false;
    });
}

export function initPhotosPicker() {
  const btn = $<HTMLButtonElement>('import-google-photos');
  btn.hidden = !googleConfigured();
  btn.addEventListener('click', () => importFromGooglePhotos());
}
