import L from 'leaflet';
import exifr from 'exifr/dist/lite.esm.mjs';
import { layersControl, map } from './map';
import { state } from './state';
import { del, get, put } from './store';
import { positionAt } from './tracks';
import { openNewPoint } from './points';
import type { Photo } from './types';
import { $, escapeHtml, getMode, setMode } from './ui';
import { isNative } from './platform';

const FULL_PX = 1600;
const THUMB_PX = 240;
/** Panoramas (at least 2:1) are sized by their short edge so they stay sharp when scrolled. */
const PANO_RATIO = 2;
const PANO_SHORT_PX = 1200;
const PANO_LONG_PX = 8000;
const PANO_THUMB_SHORT_PX = 160;
/** A GPS fix this recent counts as "where the photo was taken" for Photo here (ms). */
const FRESH_FIX_MS = 2 * 60_000;

const draftLayer = L.layerGroup();
const thumbUrls = new Map<string, string>();
export const drafts = () => state.photos.filter((p) => !p.pointId);
export const photosOf = (pointId: string) =>
  state.photos.filter((p) => p.pointId === pointId).sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0));

export function thumbUrl(p: Photo): string {
  let url = thumbUrls.get(p.id);
  if (!url) thumbUrls.set(p.id, (url = URL.createObjectURL(p.thumb)));
  return url;
}

// ---------- reading & resizing ----------
/** EXIF date/time is local time without a zone unless OffsetTimeOriginal is present. */
function exifTime(raw: unknown, offset: unknown): number | undefined {
  if (typeof raw !== 'string') return raw instanceof Date ? raw.getTime() : undefined;
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  if (typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset)) {
    return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
  }
  return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}

async function readMeta(file: File): Promise<{ takenAt?: number; lat?: number; lng?: number }> {
  try {
    const tags = await exifr.parse(file, { tiff: true, exif: true, gps: true, reviveValues: false });
    const takenAt = exifTime(tags?.DateTimeOriginal ?? tags?.CreateDate, tags?.OffsetTimeOriginal);
    let lat: number | undefined;
    let lng: number | undefined;
    try {
      const gps = await exifr.gps(file);
      if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude) && (gps.latitude || gps.longitude)) {
        ({ latitude: lat, longitude: lng } = gps);
      }
    } catch {
      /* no GPS block */
    }
    return { takenAt, lat, lng };
  } catch {
    return {};
  }
}

function encode(bmp: ImageBitmap, scale: number, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', quality),
  );
}

/** Decode once, then make the thumbnail and the stored full-size copy. */
async function makeImages(file: Blob): Promise<{ thumb: Blob; full: Blob; panorama: boolean }> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const long = Math.max(bmp.width, bmp.height);
    const short = Math.min(bmp.width, bmp.height);
    const panorama = long / short >= PANO_RATIO;
    const fullScale = panorama ? Math.min(1, PANO_SHORT_PX / short, PANO_LONG_PX / long) : Math.min(1, FULL_PX / long);
    const thumbScale = panorama ? Math.min(1, PANO_THUMB_SHORT_PX / short) : Math.min(1, THUMB_PX / long);
    return { thumb: await encode(bmp, thumbScale, 0.75), full: await encode(bmp, fullScale, 0.82), panorama };
  } finally {
    bmp.close();
  }
}

/** Fill in a missing location from recorded/imported tracks. */
function matchToTrack(p: Photo): boolean {
  if (p.takenAt == null) return false;
  const pos = positionAt(p.takenAt);
  if (!pos) return false;
  Object.assign(p, { lat: pos.lat, lng: pos.lng, locSource: 'track', matchGapSec: Math.round(pos.gapSec) });
  return true;
}

interface ImportOptions {
  /** A recent GPS fix to use if the photo has no location of its own (Photo here). */
  fix?: { lat: number; lng: number; time: number };
  /** Don't show an alert per failed file (the caller reports instead). */
  quiet?: boolean;
}

/** Store photos as drafts, locating each from EXIF GPS, a GPS track, or a fresh fix. */
export async function importFiles(files: File[], opts: ImportOptions = {}): Promise<Photo[]> {
  const added: Photo[] = [];
  for (const file of files) {
    if (!file.type.startsWith('image/') && !/\.(jpe?g|png|heic|webp)$/i.test(file.name)) continue;
    try {
      const meta = await readMeta(file);
      const images = await makeImages(file);
      const p: Photo = {
        id: crypto.randomUUID(),
        thumb: images.thumb,
        ...(images.panorama ? { panorama: true } : {}),
        fileName: file.name,
        takenAt: meta.takenAt ?? (file.lastModified || undefined),
        createdAt: new Date().toISOString(),
      };
      if (meta.lat != null && meta.lng != null) Object.assign(p, { lat: meta.lat, lng: meta.lng, locSource: 'exif' });
      else if (opts.fix && Math.abs((p.takenAt ?? Date.now()) - opts.fix.time) < FRESH_FIX_MS)
        Object.assign(p, { lat: opts.fix.lat, lng: opts.fix.lng, locSource: 'gps' });
      else matchToTrack(p);
      await put('photoBlobs', { id: p.id, blob: images.full });
      await put('photos', p);
      state.photos.push(p);
      added.push(p);
    } catch (err) {
      if (!opts.quiet) alert(`Couldn't import ${file.name}: ${(err as Error).message}`);
    }
  }
  renderPhotos();
  return added;
}

/** After tracks change, locate drafts that had no location (or a track-based one). */
export async function rematchDrafts() {
  let changed = false;
  for (const p of drafts()) {
    if (p.locSource && p.locSource !== 'track') continue;
    const before = `${p.lat},${p.lng}`;
    if (!matchToTrack(p)) {
      if (p.locSource !== 'track') continue;
      delete p.lat;
      delete p.lng;
      delete p.locSource;
      delete p.matchGapSec;
    }
    if (`${p.lat},${p.lng}` !== before) {
      await put('photos', p);
      changed = true;
    }
  }
  if (changed) renderPhotos();
}

export async function setPhotoPoint(ids: string[], pointId: string | undefined) {
  for (const id of ids) {
    const p = state.photos.find((x) => x.id === id);
    if (!p) continue;
    if (pointId) p.pointId = pointId;
    else delete p.pointId;
    await put('photos', p);
  }
  renderPhotos();
}

export async function deletePhotos(ids: string[]) {
  for (const id of ids) {
    await del('photos', id);
    await del('photoBlobs', id);
    const url = thumbUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    thumbUrls.delete(id);
  }
  state.photos = state.photos.filter((p) => !ids.includes(p.id));
  renderPhotos();
}

// ---------- viewer ----------
let viewerUrl: string | null = null;
export async function openViewer(id: string) {
  const p = state.photos.find((x) => x.id === id);
  const full = await get('photoBlobs', id);
  if (!p) return;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(full?.blob ?? p.thumb);
  const dialog = $<HTMLDialogElement>('photo-viewer');
  const img = $<HTMLImageElement>('viewer-img');
  // Panoramas fill the height and scroll sideways, starting from the middle.
  dialog.classList.toggle('pano', !!p.panorama);
  img.onload = () => {
    const box = $('viewer-scroll');
    box.scrollLeft = (box.scrollWidth - box.clientWidth) / 2;
  };
  img.src = viewerUrl;
  $('viewer-caption').textContent = describe(p) + (p.panorama ? ' · swipe to look around' : '');
  dialog.showModal();
}

// ---------- describing ----------
const fmtTime = (t?: number) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown time');

function locLabel(p: Photo): string {
  switch (p.locSource) {
    case 'exif':
      return 'Location from photo';
    case 'gps':
      return 'Location from phone GPS';
    case 'track':
      return `Matched to your track (±${p.matchGapSec ?? 0} s)`;
    case 'manual':
      return 'Placed by hand';
    default:
      return 'No location yet';
  }
}
const describe = (p: Photo) => `${p.panorama ? 'Panorama · ' : ''}${fmtTime(p.takenAt)} · ${locLabel(p)}`;

// ---------- drafts on the map & review list ----------
function draftPopup(p: Photo) {
  return `<div class="popup photo-popup">
    <img src="${thumbUrl(p)}" alt="" data-view-photo="${p.id}" />
    <div class="popup-meta">${escapeHtml(describe(p))}</div>
    <div class="popup-actions">
      <button class="btn small primary" data-photo-action="point" data-id="${p.id}">Make point</button>
      <button class="btn small" data-photo-action="place" data-id="${p.id}">Move</button>
      <button class="btn small danger" data-photo-action="discard" data-id="${p.id}">Discard</button>
    </div>
  </div>`;
}

export function renderPhotos() {
  draftLayer.clearLayers();
  const list = drafts().sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0));
  for (const p of list) {
    if (p.lat == null || p.lng == null) continue;
    const icon = L.divIcon({
      className: '',
      html: `<div class="photo-pin"><img src="${thumbUrl(p)}" alt="" /></div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    });
    const m = L.marker([p.lat, p.lng], { icon, keyboard: false });
    m.on('click', () => {
      if (getMode() === 'idle') L.popup({ maxWidth: 260 }).setLatLng(m.getLatLng()).setContent(draftPopup(p)).openOn(map);
    });
    draftLayer.addLayer(m);
  }
  const n = list.length;
  $('review-photos').hidden = n === 0;
  $('review-photos').textContent = `Review ${n} photo${n === 1 ? '' : 's'}`;
  $('photo-badge').hidden = n === 0;
  $('photo-badge').textContent = String(n);
  renderReviewList();
}

function renderReviewList() {
  const list = drafts().sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0));
  $('review-list').innerHTML = list.length
    ? list
        .map(
          (p) => `<li>
            <img src="${thumbUrl(p)}" alt="" data-view-photo="${p.id}" />
            <div class="review-text">
              <small>${escapeHtml(describe(p))}</small>
              <div class="popup-actions">
                <button class="btn small primary" data-photo-action="point" data-id="${p.id}">Make point</button>
                <button class="btn small" data-photo-action="${p.lat == null ? 'place' : 'show'}" data-id="${p.id}">${p.lat == null ? 'Place on map' : 'Show'}</button>
                <button class="btn small danger" data-photo-action="discard" data-id="${p.id}">Discard</button>
              </div>
            </div>
          </li>`,
        )
        .join('')
    : `<li class="empty">All photos reviewed.</li>`;
}

// ---------- placing a photo by hand ----------
let placingId: string | null = null;
function startPlacing(id: string) {
  placingId = id;
  $<HTMLDialogElement>('review-dialog').close();
  map.closePopup();
  setMode('place');
  $('place-hint').hidden = false;
}
function stopPlacing() {
  placingId = null;
  if (getMode() === 'place') setMode('idle');
  $('place-hint').hidden = true;
}

async function makePoint(id: string) {
  const p = state.photos.find((x) => x.id === id);
  if (!p) return;
  if (p.lat == null || p.lng == null) {
    alert('Place this photo on the map first.');
    return startPlacing(id);
  }
  $<HTMLDialogElement>('review-dialog').close();
  map.closePopup();
  openNewPoint(
    { lat: p.lat, lng: p.lng, name: '', category: 'poi', description: '' },
    { photoIds: [p.id] },
  );
}

// ---------- Photo here ----------
let pendingFix: Promise<{ lat: number; lng: number; time: number } | undefined> | null = null;
function currentFix() {
  return new Promise<{ lat: number; lng: number; time: number } | undefined>((resolve) => {
    if (!('geolocation' in navigator)) return resolve(undefined);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, time: pos.timestamp }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 },
    );
  });
}

export function toast(html: string, ms = 6000) {
  const el = $('toast');
  el.innerHTML = html;
  el.hidden = false;
  clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(setTimeout(() => (el.hidden = true), ms));
}

// ---------- wiring ----------
export function initPhotos() {
  layersControl.addOverlay(draftLayer, 'Photos to review');
  draftLayer.addTo(map);

  $<HTMLInputElement>('import-photos').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    toast(`Importing ${files.length} photo(s)…`, 60_000);
    const added = await importFiles(files);
    const located = added.filter((p) => p.lat != null).length;
    toast(
      `Imported ${added.length} photo(s): ${located} located, ${added.length - located} need placing. ` +
        `<button class="link" data-open-review>Review</button>`,
    );
    const pts = added.filter((p) => p.lat != null).map((p) => L.latLng(p.lat!, p.lng!));
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 16 });
  });

  // Photo here: start a GPS fix the moment the button is tapped, then open the camera.
  // (In the Android app the button starts a photo session instead: see cameraRoll.ts.)
  $('photo-here').addEventListener('click', () => {
    if (isNative) return;
    pendingFix = currentFix();
    $<HTMLInputElement>('photo-here-input').click();
  });
  $<HTMLInputElement>('photo-here-input').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    const fix = (await pendingFix) ?? (await currentFix());
    const [p] = await importFiles(files, { fix });
    if (!p) return;
    toast(
      p.lat != null
        ? `Photo saved for review. <button class="link" data-photo-action="point" data-id="${p.id}">Make point now</button>`
        : `Photo saved, but no location was available. <button class="link" data-open-review>Review</button>`,
    );
  });

  $('review-photos').addEventListener('click', () => $<HTMLDialogElement>('review-dialog').showModal());
  $('photo-badge').addEventListener('click', () => $<HTMLDialogElement>('review-dialog').showModal());
  $('review-close').addEventListener('click', () => $<HTMLDialogElement>('review-dialog').close());
  $('viewer-close').addEventListener('click', () => $<HTMLDialogElement>('photo-viewer').close());
  $('cancel-place').addEventListener('click', stopPlacing);

  map.on('click', async (e: L.LeafletMouseEvent) => {
    if (getMode() !== 'place' || !placingId) return;
    const p = state.photos.find((x) => x.id === placingId);
    stopPlacing();
    if (!p) return;
    Object.assign(p, { lat: e.latlng.lat, lng: e.latlng.lng, locSource: 'manual' });
    delete p.matchGapSec;
    await put('photos', p);
    renderPhotos();
    L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(draftPopup(p)).openOn(map);
  });

  // Delegated buttons: map popups, review list, toasts.
  document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-open-review]')) {
      $('toast').hidden = true;
      return $<HTMLDialogElement>('review-dialog').showModal();
    }
    const view = target.closest<HTMLElement>('[data-view-photo]')?.dataset.viewPhoto;
    if (view) return openViewer(view);
    const btn = target.closest<HTMLElement>('[data-photo-action]');
    const id = btn?.dataset.id;
    if (!btn || !id) return;
    $('toast').hidden = true;
    switch (btn.dataset.photoAction) {
      case 'point':
        return makePoint(id);
      case 'place':
        return startPlacing(id);
      case 'show': {
        const p = state.photos.find((x) => x.id === id);
        if (p?.lat == null || p.lng == null) return;
        $<HTMLDialogElement>('review-dialog').close();
        map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15));
        L.popup({ maxWidth: 260 }).setLatLng([p.lat, p.lng]).setContent(draftPopup(p)).openOn(map);
        return;
      }
      case 'discard':
        if (!confirm('Discard this photo?')) return;
        map.closePopup();
        return deletePhotos([id]);
    }
  });

  document.addEventListener('tracks-changed', () => void rematchDrafts());
}
