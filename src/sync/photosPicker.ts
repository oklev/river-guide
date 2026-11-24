import L from 'leaflet';
import { map } from '../map';
import { importFiles, toast } from '../photos';
import { $ } from '../ui';
import { googleConfigured, SCOPES } from './config';
import { getToken } from './googleAuth';

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

async function pickAndImport() {
  // From a click: may show Google's sign-in/consent for the Photos permission.
  const token = await getToken([SCOPES.photosPicker], true);
  const session = await api('sessions', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  // "/autoclose" closes Google's picker window once you're done choosing.
  window.open(`${session.pickerUri}/autoclose`, '_blank');
  toast('Choose photos in Google Photos, then come back here…', 10 * 60_000);

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

  // List and download what was picked.
  const items: any[] = [];
  let page = '';
  do {
    const r = await api(`mediaItems?sessionId=${session.id}&pageSize=100${page ? `&pageToken=${page}` : ''}`, token);
    items.push(...(r.mediaItems ?? []));
    page = r.nextPageToken ?? '';
  } while (page);
  const photos = items.filter((m) => m.type !== 'VIDEO' && m.mediaFile?.baseUrl);
  toast(`Importing ${photos.length} photo${photos.length === 1 ? '' : 's'} from Google Photos…`, 60_000);
  const files: File[] = [];
  for (const m of photos) {
    // "=d" downloads the original (with its date/time; Google strips GPS).
    const res = await fetch(`${m.mediaFile.baseUrl}=d`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    files.push(
      new File([await res.blob()], m.mediaFile.filename ?? `${m.id}.jpg`, {
        type: m.mediaFile.mimeType ?? 'image/jpeg',
        lastModified: Date.parse(m.createTime) || Date.now(),
      }),
    );
  }
  await api(`sessions/${session.id}`, token, { method: 'DELETE' }).catch(() => {});

  const added = await importFiles(files);
  const located = added.filter((p) => p.lat != null);
  toast(
    `Imported ${added.length} photo${added.length === 1 ? '' : 's'}: ${located.length} matched to a track, ` +
      `${added.length - located.length} to place by hand. <button class="link" data-open-review>Review</button>`,
    15_000,
  );
  if (located.length) map.fitBounds(L.latLngBounds(located.map((p) => L.latLng(p.lat!, p.lng!))), { padding: [60, 60], maxZoom: 16 });
}

export function initPhotosPicker() {
  const btn = $<HTMLButtonElement>('import-google-photos');
  btn.hidden = !googleConfigured();
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await pickAndImport();
    } catch (err) {
      alert(`Couldn't import from Google Photos: ${(err as Error).message}`);
    } finally {
      btn.disabled = false;
    }
  });
}
