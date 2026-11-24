import L from 'leaflet';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { map } from './map';
import { state } from './state';
import { get, put } from './store';
import { locateOnLine } from './geo';
import { fromGeoJSON, toGeoJSON, type ParsedData } from './geojson';
import { saveFile } from './platform';
import { renderPoints } from './points';
import { renderRoutes } from './routes';
import { renderTracks } from './tracks';
import { renderPhotos } from './photos';
import { renderPortages } from './portages';
import { refreshNav } from './nav';
import type { Photo, Portage, RiverPoint, Route, Track } from './types';
import { $, fmtBytes } from './ui';
import { googleConfigured, WEB_APP_URL } from './sync/config';
import { connectDrive, copyLink, parseEmails, saveAndShare } from './sync/driveShare';

/**
 * A route package (.riverguide.zip) holds everything about a route that can't
 * be re-derived: the route, nearby points, their photos, and optionally GPS
 * tracks along it. Offline maps and OSM data are left out (re-downloadable).
 *
 *   route.geojson        standard GeoJSON (route + points + tracks), readable by other tools
 *   photos/<id>.jpg      full-size photo
 *   photos/<id>.thumb.jpg
 */
const PACKAGE_VERSION = 1;
/** Rough size of one stored photo + thumbnail, for the estimate shown before export. */
const AVG_PHOTO_BYTES = 280_000;

interface PackageMeta {
  version: number;
  exportedAt: string;
  /** Photo metadata (without image data); images are separate files in the zip. */
  photos: Omit<Photo, 'thumb'>[];
}

// ---------- choosing what goes in ----------
function nearRoute(r: Route, lat: number, lng: number, km: number) {
  const loc = locateOnLine(r.coords, [lat, lng]);
  return !!loc && loc.offKm <= km;
}

/** Tracks with at least half their fixes inside the corridor count as "along this route". */
export function trackAlong(r: Route, t: Track, km: number) {
  const step = Math.max(1, Math.floor(t.fixes.length / 200)); // sample long tracks
  let inside = 0;
  let total = 0;
  for (let i = 0; i < t.fixes.length; i += step) {
    total++;
    if (nearRoute(r, t.fixes[i][0], t.fixes[i][1], km)) inside++;
  }
  return total > 0 && inside / total >= 0.5;
}

interface Selection {
  route: Route;
  points: RiverPoint[];
  photos: Photo[];
  tracks: Track[];
  portages: Portage[];
}

function select(r: Route, km: number, withPhotos: boolean, withTracks: boolean): Selection {
  const points = state.points.filter((p) => nearRoute(r, p.lat, p.lng, km));
  const ids = new Set(points.map((p) => p.id));
  return {
    route: r,
    points,
    photos: withPhotos ? state.photos.filter((ph) => ph.pointId && ids.has(ph.pointId)) : [],
    tracks: withTracks ? state.tracks.filter((t) => !t.recording && trackAlong(r, t, km)) : [],
    // Paths attached to the route, plus unattached ones that touch the corridor.
    portages: state.portages.filter(
      (p) => p.routeId === r.id || (!p.routeId && p.coords.some(([lat, lng]) => nearRoute(r, lat, lng, km))),
    ),
  };
}

// ---------- export ----------
async function buildPackage(sel: Selection): Promise<Blob> {
  const geo = toGeoJSON(sel.points, [sel.route], sel.tracks, sel.portages);
  const meta: PackageMeta = {
    version: PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    photos: sel.photos.map(({ thumb: _thumb, ...rest }) => rest),
  };
  const files: Zippable = {
    'route.geojson': strToU8(JSON.stringify({ ...geo, riverGuide: meta }, null, 1)),
  };
  for (const ph of sel.photos) {
    const full = await get('photoBlobs', ph.id);
    // JPEGs are already compressed; store them without recompressing.
    if (full) files[`photos/${ph.id}.jpg`] = [new Uint8Array(await full.blob.arrayBuffer()), { level: 0 }];
    files[`photos/${ph.id}.thumb.jpg`] = [new Uint8Array(await ph.thumb.arrayBuffer()), { level: 0 }];
  }
  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'route';

// ---------- import ----------
interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
  summary: string[];
  bounds: L.LatLng[];
}

/** Insert new items, replace older ones; keep the local copy when it's newer. */
function mergeNewer<T extends { id: string; updatedAt?: string; createdAt?: string }>(
  existing: T[],
  incoming: T[],
  res: ImportResult,
  keepLocal?: (local: T, inc: T) => T,
): T[] {
  const toWrite: T[] = [];
  for (const inc of incoming) {
    const i = existing.findIndex((x) => x.id === inc.id);
    if (i < 0) {
      existing.push(inc);
      toWrite.push(inc);
      res.added++;
      continue;
    }
    const local = existing[i];
    const stamp = (x: T) => Date.parse(x.updatedAt ?? x.createdAt ?? '') || 0;
    if (stamp(inc) > stamp(local)) {
      existing[i] = keepLocal ? keepLocal(local, inc) : inc;
      toWrite.push(existing[i]);
      res.updated++;
    } else {
      res.skipped++;
    }
  }
  return toWrite;
}

async function importParsed(data: ParsedData, photoFiles: Map<string, Uint8Array>, meta?: PackageMeta) {
  const res: ImportResult = { added: 0, updated: 0, skipped: 0, summary: [], bounds: [] };
  // Offline downloads are per-device: keep this device's record when a route is updated.
  for (const r of mergeNewer(state.routes, data.routes, res, (local, inc) => ({ ...inc, offline: local.offline }))) await put('routes', r);
  for (const p of mergeNewer(state.points, data.points, res)) await put('points', p);
  for (const t of mergeNewer(state.tracks, data.tracks, res)) await put('tracks', t);
  for (const p of mergeNewer(state.portages, data.portages, res)) await put('portages', p);

  let photoCount = 0;
  for (const m of meta?.photos ?? []) {
    if (state.photos.some((x) => x.id === m.id)) continue; // photos never change, so existing = same
    const full = photoFiles.get(`photos/${m.id}.jpg`);
    const thumb = photoFiles.get(`photos/${m.id}.thumb.jpg`) ?? full;
    if (!thumb) continue;
    const photo: Photo = { ...m, thumb: new Blob([thumb as BlobPart], { type: 'image/jpeg' }) };
    await put('photoBlobs', { id: m.id, blob: new Blob([(full ?? thumb) as BlobPart], { type: 'image/jpeg' }) });
    await put('photos', photo);
    state.photos.push(photo);
    photoCount++;
  }

  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (data.routes.length) res.summary.push(plural(data.routes.length, 'route'));
  if (data.points.length) res.summary.push(plural(data.points.length, 'point'));
  if (photoCount) res.summary.push(plural(photoCount, 'new photo'));
  if (data.portages.length) res.summary.push(plural(data.portages.length, 'portage/trail'));
  if (data.tracks.length) res.summary.push(plural(data.tracks.length, 'track'));
  res.bounds = [
    ...data.routes.flatMap((r) => r.coords.map((c) => L.latLng(c))),
    ...data.points.map((p) => L.latLng(p.lat, p.lng)),
  ];
  return res;
}

/** Import a .riverguide.zip package or a plain GeoJSON file. */
export async function importFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
  let result: ImportResult;
  if (isZip) {
    const entries = unzipSync(bytes);
    const geo = entries['route.geojson'];
    if (!geo) throw new Error('Not a River Guide route package (route.geojson missing)');
    const json = JSON.parse(strFromU8(geo));
    const meta = json.riverGuide as PackageMeta | undefined;
    if (meta && meta.version > PACKAGE_VERSION) throw new Error('This file was made by a newer version of River Guide. Update the app first.');
    const photoFiles = new Map(Object.entries(entries).filter(([k]) => k.startsWith('photos/')));
    result = await importParsed(fromGeoJSON(json), photoFiles, meta);
  } else {
    result = await importParsed(fromGeoJSON(JSON.parse(new TextDecoder().decode(bytes))), new Map());
  }
  renderRoutes();
  renderPoints();
  renderTracks();
  renderPhotos();
  renderPortages();
  void refreshNav();
  if (result.bounds.length) map.fitBounds(L.latLngBounds(result.bounds), { padding: [40, 40], maxZoom: 15 });
  const changes = [result.added && `${result.added} new`, result.updated && `${result.updated} updated`, result.skipped && `${result.skipped} unchanged (yours is newer or the same)`]
    .filter(Boolean)
    .join(', ');
  alert(`Imported ${result.summary.join(', ') || 'nothing'}.${changes ? `\n${changes}.` : ''}`);
}

// ---------- dialog ----------
let shareRoute: Route | null = null;
const dialog = () => $<HTMLDialogElement>('share-dialog');
const corridor = () => Number($<HTMLSelectElement>('share-corridor').value);
const withPhotos = () => $<HTMLInputElement>('share-photos').checked;
const withTracks = () => $<HTMLInputElement>('share-tracks').checked;

function updateSummary() {
  if (!shareRoute) return;
  const sel = select(shareRoute, corridor(), withPhotos(), withTracks());
  const parts = [
    `${sel.points.length} point${sel.points.length === 1 ? '' : 's'}`,
    sel.portages.length > 0 && `${sel.portages.length} portage/trail${sel.portages.length === 1 ? '' : 's'}`,
    withPhotos() && `${sel.photos.length} photo${sel.photos.length === 1 ? '' : 's'}`,
    withTracks() && `${sel.tracks.length} track${sel.tracks.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  const est = 20_000 + sel.photos.length * AVG_PHOTO_BYTES + sel.tracks.reduce((n, t) => n + t.fixes.length * 60, 0);
  $('share-summary').textContent = `The route plus ${parts.join(', ')} · about ${fmtBytes(est)}`;
}

export function openShare(r: Route) {
  shareRoute = r;
  map.closePopup();
  $('share-title').textContent = `Share “${r.name}”`;
  $('share-status').textContent = '';
  $('share-drive-box').hidden = !googleConfigured();
  $('share-drive-result').hidden = true;
  updateSummary();
  dialog().showModal();
}

/** Save the package to Drive (River Guide › Shared routes) and share it by email. */
async function shareToDrive() {
  if (!shareRoute) return;
  const r = shareRoute;
  const btn = $<HTMLButtonElement>('share-drive');
  const step = (m: string) => ($('share-status').textContent = m);
  const { emails, bad } = parseEmails($<HTMLInputElement>('share-emails').value);
  if (bad.length) return step(`Not an email address: ${bad.join(', ')}`);
  btn.disabled = true;
  try {
    await connectDrive(); // from the tap: Google may ask to sign in
    step('Packing…');
    const blob = await buildPackage(select(r, corridor(), withPhotos(), withTracks()));
    const link = await saveAndShare({
      folder: 'Shared routes',
      name: `${safeName(r.name)}.riverguide.zip`,
      data: blob,
      type: 'application/zip',
      emails,
      link: (id) => `${WEB_APP_URL}?import=${encodeURIComponent(id)}`,
      subject: `River Guide route: ${r.name}`,
      onStep: step,
    });
    $<HTMLAnchorElement>('share-drive-link').href = link;
    $('share-drive-result').hidden = false;
    step(
      emails.length
        ? `Saved to Google Drive and shared with ${emails.join(', ')}. Google has emailed them the link.`
        : 'Saved to Google Drive. Add email addresses to share it, or share the file from Drive.',
    );
  } catch (err) {
    step(`Couldn't save to Google Drive: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

export function initShare() {
  $('share-drive').addEventListener('click', () => void shareToDrive());
  $('share-drive-copy').addEventListener('click', () =>
    void copyLink($<HTMLAnchorElement>('share-drive-link').href, (m) => ($('share-status').textContent = m)),
  );
  for (const id of ['share-corridor', 'share-photos', 'share-tracks']) $(id).addEventListener('change', updateSummary);
  $('share-cancel').addEventListener('click', () => dialog().close());
  $('share-export').addEventListener('click', async () => {
    if (!shareRoute) return;
    const btn = $<HTMLButtonElement>('share-export');
    btn.disabled = true;
    $('share-status').textContent = 'Packing…';
    try {
      const blob = await buildPackage(select(shareRoute, corridor(), withPhotos(), withTracks()));
      await saveFile(`${safeName(shareRoute.name)}.riverguide.zip`, blob, 'application/zip');
      dialog().close();
    } catch (err) {
      $('share-status').textContent = `Export failed: ${(err as Error).message}`;
    } finally {
      btn.disabled = false;
    }
  });
}
