import { state } from './state';
import { get } from './store';
import { distKm, KM_PER_MI, lengthKm, locateOnLine } from './geo';
import { saveFile } from './platform';
import { trackAlong } from './share';
import { USGS_MAX_ZOOM, USGS_TOPO_URL } from './tiles';
import { currentObservation, observationLabel } from './observations';
import { CATEGORIES, type LatLng, type Photo, type RiverPoint, type Route, type Track } from './types';
import { reportHtml, type ReportData, type ReportItem } from './tripReportTemplate';

/**
 * Trip report: one self-contained HTML file with the map (track, planned
 * route, points), trip stats and a timeline of photos and points passed.
 * Photos and the map library are embedded; only background map tiles need
 * internet. Open it in any browser, or send it to someone.
 */
const POINT_NEAR_KM = 0.3;
const ROUTE_POINT_NEAR_KM = 0.5;
/** Photos taken this long before the first / after the last GPS fix still count. */
const PHOTO_SLACK_MS = 20 * 60_000;
/** Faster than this between fixes counts as moving (km/h). */
const MOVING_KMH = 1;
const MAX_TRACK_POINTS = 2000;

const fixLatLng = (t: Track): LatLng[] => t.fixes.map((f) => [f[0], f[1]]);

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** Time the track passed closest to a place, if it came within `km`. */
function timeAt(t: Track | undefined, p: LatLng, km: number): number | undefined {
  if (!t?.fixes.length) return undefined;
  let best = Infinity;
  let time: number | undefined;
  for (const f of t.fixes) {
    const d = distKm(p, [f[0], f[1]]);
    if (d < best) {
      best = d;
      time = f[2] || undefined;
    }
  }
  return best <= km ? time : undefined;
}

/**
 * Fixes at least this far apart in time are used for distance and speed:
 * summing every fix would count GPS jitter as movement.
 */
const STATS_SPACING_MS = 30_000;

function trackStats(t: Track) {
  const f = t.fixes;
  const timed = f.length > 1 && f[0][2] > 0 && f[f.length - 1][2] > f[0][2];
  // Thin to one fix per STATS_SPACING_MS (keeping the last). Untimed tracks (some GPX files) use every fix.
  let thin = f;
  if (timed) {
    thin = [];
    for (const x of f) if (!thin.length || x[2] - thin[thin.length - 1][2] >= STATS_SPACING_MS) thin.push(x);
    if (thin[thin.length - 1] !== f[f.length - 1]) thin.push(f[f.length - 1]);
  }
  let moving = 0;
  let movingKm = 0;
  let distanceKm = 0;
  for (let i = 1; i < thin.length; i++) {
    const km = distKm([thin[i - 1][0], thin[i - 1][1]], [thin[i][0], thin[i][1]]);
    distanceKm += km;
    const dt = (thin[i][2] - thin[i - 1][2]) / 3_600_000;
    if (dt <= 0 || dt > 0.5) continue; // gaps (paused, no signal) aren't moving time
    if (km / dt >= MOVING_KMH) {
      moving += dt;
      movingKm += km;
    }
  }
  const start = f[0]?.[2] || undefined;
  const end = f[f.length - 1]?.[2] || undefined;
  return {
    distanceKm,
    start,
    end,
    totalMs: start && end ? end - start : undefined,
    movingMs: moving * 3_600_000,
    avgKmh: moving > 0 ? movingKm / moving : undefined,
  };
}

function caption(p: Photo, points: Map<string, RiverPoint>): { title: string; text: string } {
  const pt = p.pointId ? points.get(p.pointId) : undefined;
  const by = p.credit ? `Photo by ${p.credit}` : '';
  if (!pt) return { title: p.panorama ? 'Panorama' : 'Photo', text: by };
  return { title: pt.name, text: [pt.description, by].filter(Boolean).join(' · ') };
}

export interface ReportSource {
  route?: Route;
  track?: Track;
}

export async function buildReport({ route, track }: ReportSource): Promise<ReportData> {
  const line: LatLng[] = route?.coords ?? (track ? fixLatLng(track) : []);
  const near = (p: LatLng, km: number) => {
    if (track && (locateOnLine(fixLatLng(track), p)?.offKm ?? Infinity) <= km) return true;
    return !!route && (locateOnLine(route.coords, p)?.offKm ?? Infinity) <= km;
  };
  const mileOf = (p: LatLng) => {
    const loc = locateOnLine(line, p);
    return loc && loc.offKm <= 2 ? loc.alongKm / KM_PER_MI : undefined;
  };

  // Points along the way.
  const points = state.points.filter((p) => near([p.lat, p.lng], track ? POINT_NEAR_KM : ROUTE_POINT_NEAR_KM));
  const pointById = new Map(state.points.map((p) => [p.id, p]));

  // Photos: with a track, the ones taken during the trip; without, the ones on the route's points.
  const stats = track ? trackStats(track) : undefined;
  const ids = new Set(points.map((p) => p.id));
  const photos = state.photos
    .filter((ph) => {
      if (stats?.start && stats.end && ph.takenAt) {
        if (ph.takenAt < stats.start - PHOTO_SLACK_MS || ph.takenAt > stats.end + PHOTO_SLACK_MS) return false;
        return ph.lat == null || near([ph.lat, ph.lng!], 2);
      }
      return (ph.pointId && ids.has(ph.pointId)) || (ph.lat != null && near([ph.lat, ph.lng!], ROUTE_POINT_NEAR_KM));
    })
    .sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0));

  const items: ReportItem[] = [];
  const photoData: ReportData['photos'] = [];
  for (const ph of photos) {
    const full = await get('photoBlobs', ph.id);
    const { title, text } = caption(ph, pointById);
    const at: LatLng | undefined = ph.lat != null ? [ph.lat, ph.lng!] : undefined;
    photoData.push({ src: await blobToDataUrl(full?.blob ?? ph.thumb), panorama: !!ph.panorama });
    items.push({
      kind: 'photo',
      title,
      text,
      time: ph.takenAt,
      mile: at ? mileOf(at) : undefined,
      at,
      photo: photoData.length - 1,
    });
  }
  for (const p of points) {
    // Points with their own photo in the report are already covered by that photo.
    if (photos.some((ph) => ph.pointId === p.id)) continue;
    const obs = observationLabel(currentObservation(p), 'month');
    items.push({
      kind: 'point',
      title: p.name,
      text: [p.description, obs].filter(Boolean).join(' · '),
      category: CATEGORIES[p.category]?.label ?? p.category,
      icon: CATEGORIES[p.category]?.icon,
      color: CATEGORIES[p.category]?.color,
      time: timeAt(track, [p.lat, p.lng], POINT_NEAR_KM),
      mile: p.riverMile ?? mileOf([p.lat, p.lng]),
      at: [p.lat, p.lng],
    });
  }
  if (track?.fixes.length) {
    const first = track.fixes[0];
    const last = track.fixes[track.fixes.length - 1];
    items.push({ kind: 'start', title: 'Start', text: '', time: first[2] || undefined, mile: mileOf([first[0], first[1]]), at: [first[0], first[1]] });
    items.push({ kind: 'finish', title: 'Finish', text: '', time: last[2] || undefined, mile: mileOf([last[0], last[1]]), at: [last[0], last[1]] });
  }
  // In time order on a recorded trip; by river mile otherwise (and for anything without a time).
  const rank = (i: ReportItem) => (i.kind === 'start' ? 0 : i.kind === 'finish' ? 2 : 1);
  items.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.time != null && b.time != null ? a.time - b.time : (a.mile ?? Infinity) - (b.mile ?? Infinity)),
  );

  // A thinned track keeps the file small without losing its shape.
  const step = track ? Math.max(1, Math.ceil(track.fixes.length / MAX_TRACK_POINTS)) : 1;
  // [lat, lng, time ms (0 if unknown)]: times drive the speed dots, sun gauge and hover.
  const trackLine: [number, number, number][] = track
    ? track.fixes.filter((_, i, a) => i % step === 0 || i === a.length - 1).map((f) => [f[0], f[1], f[2] || 0])
    : [];

  const dateOf = stats?.start ?? photos[0]?.takenAt ?? (route ? Date.parse(route.updatedAt) : Date.now());
  return {
    title: route?.name ?? track?.name ?? 'Trip',
    subtitle: route?.description ?? '',
    date: dateOf,
    stats: {
      distanceMi: stats ? stats.distanceKm / KM_PER_MI : route ? lengthKm(route.coords) / KM_PER_MI : undefined,
      totalMs: stats?.totalMs,
      movingMs: stats?.movingMs || undefined,
      avgMph: stats?.avgKmh ? stats.avgKmh / KM_PER_MI : undefined,
      photos: photos.length,
      points: points.length,
    },
    route: route?.coords ?? [],
    routeColor: route?.color ?? '#1565c0',
    track: trackLine,
    items,
    photos: photoData,
    tiles: { url: USGS_TOPO_URL, maxNativeZoom: USGS_MAX_ZOOM, attribution: 'USGS The National Map' },
    generated: Date.now(),
  };
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'trip';

/** The most recent finished track along a route, if any. */
export function latestTrackAlong(r: Route): Track | undefined {
  return state.tracks
    .filter((t) => !t.recording && t.fixes.length > 1 && trackAlong(r, t, 0.5))
    .sort((a, b) => (b.fixes[0]?.[2] ?? 0) - (a.fixes[0]?.[2] ?? 0))[0];
}

/** The route a track follows, if any. */
export function routeAlong(t: Track): Route | undefined {
  return state.routes.find((r) => trackAlong(r, t, 0.5));
}

export async function exportTripReport(src: ReportSource) {
  const data = await buildReport(src);
  const html = await reportHtml(data);
  await saveFile(`${safeName(data.title)}-trip-report.html`, html, 'text/html');
}
