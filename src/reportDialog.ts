import { map } from './map';
import { editor } from './routes';
import { thumbUrl } from './photos';
import { KM_PER_MI } from './geo';
import { $, escapeHtml, fmtMi } from './ui';
import {
  candidatePhotos,
  candidateTracks,
  defaultOptions,
  exportTripReport,
  trackStats,
  type ReportOptions,
  type ReportSource,
} from './tripReport';
import type { LatLng, Photo, Track } from './types';

/**
 * Trip report dialog: choose the title, which tracks and photos to include,
 * which features to show, and optionally adjust the planned route's line for
 * this report only (the saved route is never changed).
 */
let opts: ReportOptions;
let savedRoute: { coords: LatLng[]; color: string } | undefined;
/** The line to use: the saved route's, or one adjusted for this report. */
let routeCoords: LatLng[] | undefined;
let showRoute = true;
const currentRoute = () => (showRoute && savedRoute && routeCoords ? { coords: routeCoords, color: savedRoute.color } : undefined);
let allTracks: Track[] = [];
let photos: Photo[] = [];
/** Photos ticked by default for the chosen tracks. */
let defaults = new Set<string>();
/** The user's own ticks/unticks, kept when the track choice changes. */
const overrides = new Map<string, boolean>();

const dialog = () => $<HTMLDialogElement>('report-dialog');
const check = (id: string) => $<HTMLInputElement>(id);

const fmtDate = (t?: number) =>
  t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'no times';

function renderTracks() {
  const box = $('rep-tracks');
  if (!allTracks.length) {
    box.innerHTML = '<p class="muted small">No recorded tracks along this route. The report will list its points and photos by river mile.</p>';
    return;
  }
  box.innerHTML = allTracks
    .map((t) => {
      const on = opts.tracks.includes(t);
      const len = fmtMi(trackStats(t).distanceKm / KM_PER_MI);
      return `<label class="check-row"><input type="checkbox" data-track="${t.id}" ${on ? 'checked' : ''} />
        <span>${escapeHtml(t.name)} <span class="muted">· ${fmtDate(t.fixes[0]?.[2])} · ${len}</span></span></label>`;
    })
    .join('');
}

function refreshPhotoCandidates() {
  const c = candidatePhotos(routeCoords, opts.tracks);
  photos = c.photos;
  defaults = c.selected;
  renderPhotos();
}

const isOn = (ph: Photo) => overrides.get(ph.id) ?? defaults.has(ph.id);

function renderPhotos() {
  const box = $('rep-photos');
  box.innerHTML = '';
  if (!photos.length) {
    box.innerHTML = '<p class="muted small">No photos along this route or from these tracks.</p>';
  }
  for (const ph of photos) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = ph.takenAt ? new Date(ph.takenAt).toLocaleString() : ph.fileName;
    b.setAttribute('aria-pressed', String(isOn(ph)));
    const img = document.createElement('img');
    img.src = thumbUrl(ph);
    img.alt = '';
    b.append(img);
    b.addEventListener('click', () => {
      overrides.set(ph.id, !isOn(ph));
      b.setAttribute('aria-pressed', String(isOn(ph)));
      updateCount();
    });
    box.append(b);
  }
  updateCount();
}

function updateCount() {
  const n = photos.filter(isOn).length;
  $('rep-photo-count').textContent = photos.length ? `(${n} of ${photos.length})` : '';
}

function renderRoute() {
  $('rep-route-box').hidden = !savedRoute;
  if (!savedRoute) return;
  const adjusted = routeCoords !== savedRoute.coords;
  $('rep-route-reset').hidden = !adjusted;
  $('rep-route-note').hidden = !adjusted;
  check('rep-route').checked = showRoute;
  $<HTMLButtonElement>('rep-route-edit').disabled = !showRoute;
}

/** Adjust the line on the map, then come back to the dialog. */
function adjustRoute() {
  if (!savedRoute || !routeCoords) return;
  dialog().close('adjust');
  map.closePopup();
  editor.start(
    routeCoords,
    savedRoute.color,
    (coords) => {
      if (coords && coords.length > 1) routeCoords = coords;
      renderRoute();
      refreshPhotoCandidates();
      dialog().showModal();
    },
    { hint: 'Adjusting the line for this report only. Your saved route won’t change.' },
  );
}

export function openReportDialog(src: ReportSource) {
  opts = defaultOptions(src);
  savedRoute = opts.route;
  routeCoords = savedRoute?.coords;
  showRoute = true;
  allTracks = candidateTracks(src).tracks;
  overrides.clear();
  check('rep-title').value = opts.title;
  $<HTMLTextAreaElement>('rep-subtitle').value = opts.subtitle;
  for (const k of ['points', 'stats', 'speed', 'sun', 'legend'] as const) {
    check(`rep-${k}`).checked = k === 'points' ? opts.points : opts.show[k];
  }
  $('rep-status').textContent = '';
  renderRoute();
  renderTracks();
  refreshPhotoCandidates();
  map.closePopup();
  dialog().showModal();
}

async function save() {
  const btn = $<HTMLButtonElement>('rep-save');
  opts.title = check('rep-title').value.trim() || 'Trip';
  opts.subtitle = $<HTMLTextAreaElement>('rep-subtitle').value.trim();
  opts.route = currentRoute();
  opts.photoIds = photos.filter(isOn).map((ph) => ph.id);
  opts.points = check('rep-points').checked;
  opts.show = {
    stats: check('rep-stats').checked,
    speed: check('rep-speed').checked,
    sun: check('rep-sun').checked,
    legend: check('rep-legend').checked,
  };
  btn.disabled = true;
  $('rep-status').textContent = 'Making the report…';
  try {
    await exportTripReport(opts);
    dialog().close('saved');
  } catch (err) {
    $('rep-status').textContent = `Couldn't make the report: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

export function initReportDialog() {
  $('rep-tracks').addEventListener('change', (e) => {
    const id = (e.target as HTMLElement).dataset.track;
    const t = allTracks.find((x) => x.id === id);
    if (!t) return;
    opts.tracks = (e.target as HTMLInputElement).checked ? [...opts.tracks, t] : opts.tracks.filter((x) => x !== t);
    refreshPhotoCandidates();
  });
  check('rep-route').addEventListener('change', () => {
    showRoute = check('rep-route').checked;
    renderRoute();
  });
  $('rep-route-edit').addEventListener('click', adjustRoute);
  $('rep-route-reset').addEventListener('click', () => {
    routeCoords = savedRoute?.coords;
    renderRoute();
    refreshPhotoCandidates();
  });
  $('rep-photos-all').addEventListener('click', () => {
    for (const ph of photos) overrides.set(ph.id, true);
    renderPhotos();
  });
  $('rep-photos-none').addEventListener('click', () => {
    for (const ph of photos) overrides.set(ph.id, false);
    renderPhotos();
  });
  $('rep-save').addEventListener('click', () => void save());
}
