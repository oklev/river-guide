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

/** An access point counts as passed if the track comes this close (km). */
const ACCESS_NEAR_KM = 0.3;

/**
 * When the track was on the water: from passing the first Access point to
 * passing the last (anything else is e.g. driving to the put-in). With one
 * access point it's the put-in if passed early in the track, the take-out if
 * late. Undefined when no access point is near (the whole track counts).
 */
export function waterWindow(t: Track): [number, number] | undefined {
  const f = t.fixes;
  if (f.length < 2 || !(f[0][2] > 0) || !(f[f.length - 1][2] > f[0][2])) return undefined;
  const passes: number[] = [];
  for (const p of state.points) {
    if (p.category !== 'access') continue;
    let best = Infinity;
    let time = 0;
    for (const x of f) {
      const d = distKm([p.lat, p.lng], [x[0], x[1]]);
      if (d < best) {
        best = d;
        time = x[2];
      }
    }
    if (best <= ACCESS_NEAR_KM) passes.push(time);
  }
  if (!passes.length) return undefined;
  const t0 = f[0][2];
  const t1 = f[f.length - 1][2];
  let start = Math.min(...passes);
  let end = Math.max(...passes);
  if (start === end) {
    if (start - t0 < t1 - start) end = t1;
    else start = t0;
  }
  return end > start ? [start, end] : undefined;
}

/** Only the fixes inside a time window (all of them without one). */
export function onWater(t: Track): Track {
  const w = waterWindow(t);
  return w ? { ...t, fixes: t.fixes.filter((x) => x[2] >= w[0] && x[2] <= w[1]) } : t;
}

export function trackStats(t: Track) {
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

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'trip';

export interface ReportSource {
  route?: Route;
  track?: Track;
}

/** What goes into a report: chosen in the report dialog. */
export interface ReportOptions {
  title: string;
  subtitle: string;
  /** The planned route line (possibly adjusted just for this report), or none. */
  route?: { coords: LatLng[]; color: string };
  tracks: Track[];
  photoIds: string[];
  points: boolean;
  show: ReportData['show'];
}

const usable = (t: Track) => !t.recording && t.fixes.length > 1;
const startOf = (t: Track) => t.fixes[0]?.[2] ?? 0;
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** Tracks worth offering for a report, newest first, and which to tick by default. */
export function candidateTracks({ route, track }: ReportSource): { tracks: Track[]; selected: Track[] } {
  let tracks = state.tracks.filter(usable);
  if (route) tracks = tracks.filter((t) => t === track || trackAlong(route, t, 0.5));
  else if (track) tracks = tracks.filter((t) => t === track || (startOf(t) > 0 && sameDay(startOf(t), startOf(track))));
  tracks.sort((a, b) => startOf(b) - startOf(a));
  const selected = track ? [track] : tracks.slice(0, 1);
  return { tracks, selected };
}

function nearAny(lines: LatLng[][], p: LatLng, km: number) {
  return lines.some((l) => l.length > 1 && (locateOnLine(l, p)?.offKm ?? Infinity) <= km);
}

/**
 * Photos worth offering: ones taken during the chosen tracks, plus ones along
 * the route. Ticked by default: the trip's photos (or, with no track, the
 * route's).
 */
export function candidatePhotos(routeCoords: LatLng[] | undefined, tracks: Track[]): { photos: Photo[]; selected: Set<string> } {
  const lines = [...tracks.map(fixLatLng), ...(routeCoords ? [routeCoords] : [])];
  const windows = tracks.map((t) => trackStats(onWater(t))).filter((s) => s.start && s.end);
  const during = (ph: Photo) =>
    !!ph.takenAt && windows.some((w) => ph.takenAt! >= w.start! - PHOTO_SLACK_MS && ph.takenAt! <= w.end! + PHOTO_SLACK_MS);
  const pointIds = new Set(state.points.filter((p) => nearAny(lines, [p.lat, p.lng], ROUTE_POINT_NEAR_KM)).map((p) => p.id));
  const along = (ph: Photo) =>
    (!!ph.pointId && pointIds.has(ph.pointId)) || (ph.lat != null && nearAny(lines, [ph.lat, ph.lng!], ROUTE_POINT_NEAR_KM));
  const photos = state.photos
    .filter((ph) => (during(ph) && (ph.lat == null || nearAny(lines, [ph.lat, ph.lng!], 2))) || along(ph))
    .sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0));
  const selected = new Set(photos.filter((ph) => (windows.length ? during(ph) : along(ph))).map((ph) => ph.id));
  return { photos, selected };
}

/** Sensible defaults for the dialog. */
export function defaultOptions(src: ReportSource): ReportOptions {
  const { selected: tracks } = candidateTracks(src);
  const route = src.route ?? (src.track ? routeAlong(src.track) : undefined);
  const { selected } = candidatePhotos(route?.coords, tracks);
  return {
    title: route?.name ?? src.track?.name ?? 'Trip',
    subtitle: route?.description ?? '',
    route: route ? { coords: route.coords, color: route.color } : undefined,
    tracks,
    photoIds: [...selected],
    points: true,
    show: { stats: true, sun: true, speed: true, legend: true },
  };
}

export async function buildReport(o: ReportOptions): Promise<ReportData> {
  const trackLines = o.tracks.map(fixLatLng);
  const routeCoords = o.route?.coords;
  const line: LatLng[] = routeCoords ?? trackLines[0] ?? [];
  const lines = [...trackLines, ...(routeCoords ? [routeCoords] : [])];
  const mileOf = (p: LatLng) => {
    const loc = locateOnLine(line, p);
    return loc && loc.offKm <= 2 ? loc.alongKm / KM_PER_MI : undefined;
  };
  /** Time a chosen track passed closest to a place. */
  const timeNear = (p: LatLng) => {
    for (const t of o.tracks) {
      const time = timeAt(t, p, POINT_NEAR_KM);
      if (time) return time;
    }
    return undefined;
  };

  // Points along the way.
  const points = o.points
    ? state.points.filter((p) => nearAny(lines, [p.lat, p.lng], o.tracks.length ? POINT_NEAR_KM : ROUTE_POINT_NEAR_KM))
    : [];
  const pointById = new Map(state.points.map((p) => [p.id, p]));
  const wanted = new Set(o.photoIds);
  const photos = state.photos.filter((ph) => wanted.has(ph.id)).sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0));

  // Combined stats over all chosen tracks.
  // Stats cover time on the water only (not driving to the put-in).
  const water = o.tracks.map(onWater);
  const all = water.map(trackStats);
  const sum = (f: (s: ReturnType<typeof trackStats>) => number | undefined) => all.reduce((n, s) => n + (f(s) ?? 0), 0);
  const movingMs = sum((s) => s.movingMs);
  const movingKm = all.reduce((n, s) => n + (s.avgKmh ? (s.avgKmh * s.movingMs) / 3_600_000 : 0), 0);

  const items: ReportItem[] = [];
  const photoData: ReportData['photos'] = [];
  for (const ph of photos) {
    const full = await get('photoBlobs', ph.id);
    const { title, text } = caption(ph, pointById);
    const at: LatLng | undefined = ph.lat != null ? [ph.lat, ph.lng!] : undefined;
    photoData.push({ src: await blobToDataUrl(full?.blob ?? ph.thumb), panorama: !!ph.panorama });
    items.push({ kind: 'photo', title, text, time: ph.takenAt, mile: at ? mileOf(at) : undefined, at, photo: photoData.length - 1 });
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
      time: timeNear([p.lat, p.lng]),
      mile: p.riverMile ?? mileOf([p.lat, p.lng]),
      at: [p.lat, p.lng],
    });
  }
  const ordered = [...o.tracks].sort((a, b) => startOf(a) - startOf(b));
  const orderedWater = ordered.map(onWater).filter((t) => t.fixes.length);
  const first = orderedWater[0]?.fixes[0];
  const lastTrack = orderedWater[orderedWater.length - 1];
  const last = lastTrack?.fixes[lastTrack.fixes.length - 1];
  if (first && last) {
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

  // Thinned tracks keep the file small without losing their shape.
  // [lat, lng, time ms (0 if unknown)]: times drive the speed colours, sun strip and hover.
  const total = ordered.reduce((n, t) => n + t.fixes.length, 0);
  const step = Math.max(1, Math.ceil(total / MAX_TRACK_POINTS));
  const tracks = ordered.map((t) =>
    t.fixes.filter((_, i, a) => i % step === 0 || i === a.length - 1).map((f) => [f[0], f[1], f[2] || 0] as [number, number, number]),
  );

  const starts = all.map((s) => s.start).filter((x): x is number => !!x);
  const dateOf = starts.length ? Math.min(...starts) : (photos[0]?.takenAt ?? Date.now());
  return {
    title: o.title,
    subtitle: o.subtitle,
    date: dateOf,
    stats: {
      distanceMi: o.tracks.length ? sum((s) => s.distanceKm) / KM_PER_MI : routeCoords ? lengthKm(routeCoords) / KM_PER_MI : undefined,
      totalMs: sum((s) => s.totalMs) || undefined,
      movingMs: movingMs || undefined,
      avgMph: movingMs ? movingKm / (movingMs / 3_600_000) / KM_PER_MI : undefined,
      photos: photos.length,
      points: points.length,
    },
    route: routeCoords ?? [],
    routeColor: o.route?.color ?? '#1565c0',
    tracks,
    water: ordered.map((t) => waterWindow(t) ?? null),
    items,
    photos: photoData,
    show: o.show,
    tiles: { url: USGS_TOPO_URL, maxNativeZoom: USGS_MAX_ZOOM, attribution: 'USGS The National Map' },
    generated: Date.now(),
  };
}

/** The route a track follows, if any. */
export function routeAlong(t: Track): Route | undefined {
  return state.routes.find((r) => trackAlong(r, t, 0.5));
}

export async function exportTripReport(o: ReportOptions) {
  const data = await buildReport(o);
  const html = await reportHtml(data);
  await saveFile(`${safeName(data.title)}-trip-report.html`, html, 'text/html');
}
