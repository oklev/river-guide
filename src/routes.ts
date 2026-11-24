import L from 'leaflet';
import { map } from './map';
import { offlineAreas, state } from './state';
import { del, put } from './store';
import { KM_PER_MI, lengthKm, lengthMi } from './geo';
import { RouteEditor } from './routeEditor';
import { cancelAddPoint, closeSidebarOnMobile } from './points';
import {
  AVG_TILE_BYTES,
  OFFLINE_MIN_ZOOM,
  USGS_MAX_ZOOM,
  cachedTileCount,
  clearTiles,
  corridorTileCoords,
  corridorTiles,
  deleteTiles,
  downloadTiles,
} from './tiles';
import { OFM_MAX_TILES, OSM_ZOOM, clearOsm, deleteOsmTiles, downloadOsm, loadAllOsm, osmTileCount, outdatedOsmCount } from './osm';
import { renderOsm, rerenderOsm } from './osmLayer';
import { openShare } from './share';
import { detachFromRoute, portageMile, portagesOf } from './portages';
import { fmtValue, gaugesNearRoute, refreshGauges, routeConditions } from './gauges';
import { forgetNav, refreshNav } from './nav';
import { CATEGORIES, GAUGE_PARAMS, PATH_KINDS, ROUTE_COLORS, type GaugeParam, type LatLng, type OfflineArea, type Route, type RouteFork } from './types';
import { allLines, forkFromDrawing, locateOnRoute, MAIN, riverKm } from './routeGraph';
import type { TileCoord } from './tiles';
import { $, escapeHtml, fmtBytes, fmtMi, fmtWalk, getMode } from './ui';

/** Above this, the download button is disabled; keeps a stray 50 km buffer from pulling gigabytes. */
const MAX_TILES = 20_000;
/** Points this close to a route are listed in its "along this route" section. */
const ALONG_KM = 0.5;

const lines = new Map<string, L.Polyline>();
/** Fork lines, keyed "routeId:forkId". */
const forkLines = new Map<string, L.Polyline>();
export const editor = new RouteEditor(map);
const findRoute = (id: string) => state.routes.find((r) => r.id === id);

// ---------- rendering ----------
function offlineLabel(r: Route): string {
  if (!r.offline) return 'Not saved for offline';
  if (r.offline.partial) return 'Offline download incomplete';
  if (r.offline.stale) return 'Offline map outdated (line changed)';
  return `Offline ✓ ${new Date(r.offline.downloadedAt).toLocaleDateString()}`;
}

function conditionsHtml(r: Route): string {
  const c = routeConditions(r);
  return c ? `<div class="conditions">${c.html}</div>` : '';
}

function popupHtml(r: Route): string {
  const pointRows = state.points
    .map((p) => ({ p, loc: locateOnRoute(r, [p.lat, p.lng]) }))
    .filter((x) => x.loc && x.loc.offKm <= ALONG_KM)
    .map(({ p, loc }) => {
      const c = CATEGORIES[p.category];
      const sev = p.severity ? ` <em class="sev-${p.severity}">${p.severity}</em>` : '';
      const fork = loc!.branch !== MAIN ? r.forks?.find((f) => f.id === loc!.branch) : undefined;
      const where = fork ? ` <small>· ${escapeHtml(fork.name || (fork.rejoin != null ? 'channel' : 'side branch'))}</small>` : '';
      return { mi: riverKm(r, loc!) / KM_PER_MI, html: `<span style="color:${c.color}">${c.icon}</span> ${escapeHtml(p.name)}${sev}${where}` };
    });
  const pathRows = portagesOf(r.id).map((p) => {
    const k = PATH_KINDS[p.kind];
    return {
      mi: portageMile(p, r) ?? 0,
      html: `<span style="color:${k.color}">${k.icon}</span> ${escapeHtml(p.name)} <small>· ${fmtWalk(lengthKm(p.coords))}</small>`,
    };
  });
  const along = [...pointRows, ...pathRows].sort((a, b) => a.mi - b.mi).slice(0, 20);
  const alongHtml = along.length
    ? `<ul class="along">${along.map((x) => `<li><span class="mi">${x.mi.toFixed(1)}</span> ${x.html}</li>`).join('')}</ul>`
    : '';
  return `
    <div class="popup">
      <strong>${escapeHtml(r.name)}</strong>
      <div class="popup-meta">${fmtMi(lengthMi(r.coords))}${r.forks?.length ? ` · ${r.forks.length} fork${r.forks.length === 1 ? '' : 's'}` : ''} · ${escapeHtml(offlineLabel(r))}</div>
      ${conditionsHtml(r)}
      ${r.description ? `<p>${escapeHtml(r.description).replace(/\n/g, '<br>')}</p>` : ''}
      ${alongHtml}
      <div class="popup-actions">
        <button class="btn small" data-route-action="details" data-id="${r.id}">Edit</button>
        <button class="btn small" data-route-action="line" data-id="${r.id}">Edit line</button>
        <button class="btn small" data-route-action="fork" data-id="${r.id}" title="Add a channel or side branch">+ Fork</button>
        <button class="btn small" data-route-action="reverse" data-id="${r.id}" title="Swap put-in and take-out">⇄</button>
        <button class="btn small" data-route-action="share" data-id="${r.id}">Share…</button>
        <button class="btn small" data-route-action="report" data-id="${r.id}">Trip report…</button>
        <button class="btn small primary" data-route-action="offline" data-id="${r.id}">Offline…</button>
      </div>
    </div>`;
}

function forkPopupHtml(r: Route, f: RouteFork): string {
  const kind = f.rejoin != null ? 'Channel' : 'Side branch';
  const miles =
    f.rejoin != null
      ? `rejoins at mile ${(f.rejoin / KM_PER_MI).toFixed(1)}`
      : `ends ${fmtMi(lengthMi(f.coords))} up the branch`;
  return `<div class="popup">
    <strong>${escapeHtml(f.name || kind)}</strong>
    <div class="popup-meta">${kind} of “${escapeHtml(r.name)}” · leaves at mile ${(f.from / KM_PER_MI).toFixed(1)}, ${miles} · ${fmtMi(lengthMi(f.coords))}</div>
    <div class="popup-actions">
      <button class="btn small" data-fork-action="rename" data-id="${r.id}" data-fork="${f.id}">Rename</button>
      <button class="btn small" data-fork-action="line" data-id="${r.id}" data-fork="${f.id}">Edit line</button>
      <button class="btn small danger" data-fork-action="delete" data-id="${r.id}" data-fork="${f.id}">Delete fork</button>
      <button class="btn small" data-route-action="open" data-id="${r.id}">Route…</button>
    </div></div>`;
}

function upsertForks(r: Route) {
  const keep = new Set<string>();
  for (const f of r.forks ?? []) {
    const key = `${r.id}:${f.id}`;
    keep.add(key);
    let line = forkLines.get(key);
    if (!line) {
      line = L.polyline([], { weight: 4, opacity: 0.85 });
      line.on('click', (e: L.LeafletMouseEvent) => {
        if (getMode() !== 'idle') return;
        const route = findRoute(r.id);
        const fork = route?.forks?.find((x) => x.id === f.id);
        if (route && fork) L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent(forkPopupHtml(route, fork)).openOn(map);
      });
      forkLines.set(key, line);
    }
    line.setLatLngs(f.coords).setStyle({ color: r.color }).addTo(map);
  }
  for (const [key, line] of forkLines) {
    if (key.startsWith(`${r.id}:`) && !keep.has(key)) {
      line.remove();
      forkLines.delete(key);
    }
  }
}

/** After the main line changes, re-attach forks where their ends now meet it. */
function resnapForks(r: Route) {
  r.forks = (r.forks ?? []).flatMap((f) => {
    const redone = forkFromDrawing(r, f.coords, f.id, f.name);
    if (typeof redone !== 'string') {
      // A channel drawn the other way round after a reversal: flip it so it runs downstream.
      if (redone.rejoin != null && redone.rejoin < redone.from) {
        const flipped = forkFromDrawing(r, [...f.coords].reverse(), f.id, f.name);
        return typeof flipped === 'string' ? [redone] : [flipped];
      }
      return [redone];
    }
    // Its start no longer meets the line: maybe the other end does (after a reversal).
    const flipped = forkFromDrawing(r, [...f.coords].reverse(), f.id, f.name);
    return typeof flipped === 'string' ? [] : [flipped];
  });
}

function drawFork(r: Route, fork?: RouteFork) {
  cancelAddPoint();
  map.closePopup();
  closeSidebarOnMobile();
  editor.start(
    fork?.coords ?? [],
    r.color,
    async (coords) => {
      if (!coords) return renderRoutes();
      const id = fork?.id ?? crypto.randomUUID();
      const made = forkFromDrawing(r, coords, id, fork?.name);
      if (typeof made === 'string') {
        alert(made);
        return renderRoutes();
      }
      if (!fork) {
        const name = prompt(`Name this ${made.rejoin != null ? 'channel' : 'side branch'} (optional)`, '')?.trim();
        if (name) made.name = name;
      }
      r.forks = [...(r.forks ?? []).filter((x) => x.id !== id), made];
      if (r.offline) r.offline.stale = true;
      await saveRoute(r);
    },
    {
      hint: 'Start on the route line and tap along the fork. End back on the route for a channel that rejoins, or anywhere for a side branch.',
      format: (km) => fmtMi(km / KM_PER_MI),
    },
  );
}

function upsertLine(r: Route) {
  let line = lines.get(r.id);
  if (!line) {
    line = L.polyline([], { weight: 5, opacity: 0.85 });
    // Taps on a line while drawing or placing a point belong to the map, not this popup.
    line.on('click', (e: L.LeafletMouseEvent) => {
      if (getMode() === 'idle') openRoutePopup(r.id, e.latlng);
    });
    lines.set(r.id, line);
  }
  line.setLatLngs(r.coords).setStyle({ color: r.color }).addTo(map);
  upsertForks(r);
}

export function renderRoutes() {
  for (const r of state.routes) upsertLine(r);
  for (const [id, line] of lines) {
    if (!findRoute(id)) {
      line.remove();
      lines.delete(id);
    }
  }
  for (const [key, line] of forkLines) {
    if (!findRoute(key.split(':')[0])) {
      line.remove();
      forkLines.delete(key);
    }
  }
  $('route-list').innerHTML = state.routes.length
    ? [...state.routes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (r) => `<li data-id="${r.id}">
            <span class="swatch" style="background:${r.color}"></span>
            <span class="li-text"><strong>${escapeHtml(r.name)}</strong>
              <small>${fmtMi(lengthMi(r.coords))} · ${escapeHtml(routeConditions(r)?.text ?? offlineLabel(r))}</small></span>
          </li>`,
        )
        .join('')
    : `<li class="empty">No routes yet. Use “+ New route” and tap along the river to trace one.</li>`;
}

function openRoutePopup(id: string, at: L.LatLng) {
  const r = findRoute(id);
  if (r) L.popup({ maxWidth: 320 }).setLatLng(at).setContent(popupHtml(r)).openOn(map);
}

function focusRoute(r: Route) {
  const line = lines.get(r.id);
  if (!line) return;
  map.fitBounds(line.getBounds(), { padding: [40, 40] });
  openRoutePopup(r.id, line.getCenter());
}

async function saveRoute(r: Route) {
  r.updatedAt = new Date().toISOString();
  await put('routes', r);
  const i = state.routes.findIndex((x) => x.id === r.id);
  if (i >= 0) state.routes[i] = r;
  else state.routes.push(r);
  renderRoutes();
}

// ---------- drawing ----------
function startNewRoute() {
  if (getMode() === 'route') return;
  cancelAddPoint();
  closeSidebarOnMobile();
  const color = ROUTE_COLORS[state.routes.length % ROUTE_COLORS.length];
  editor.start([], color, async (coords) => {
    if (coords) await createRoute(coords, undefined, color);
  });
}

/** Save a new route (e.g. traced by hand or made from a GPS track) and ask for its name. */
export async function createRoute(coords: LatLng[], name?: string, color?: string) {
  const now = new Date().toISOString();
  const r: Route = {
    id: crypto.randomUUID(),
    name: name ?? `Route ${state.routes.length + 1}`,
    description: '',
    color: color ?? ROUTE_COLORS[state.routes.length % ROUTE_COLORS.length],
    coords,
    createdAt: now,
    updatedAt: now,
  };
  await saveRoute(r); // save right away so the line is never lost
  void refreshGauges();
  void refreshNav();
  focusRoute(r);
  openDetails(r, true);
}

function editLine(r: Route) {
  cancelAddPoint();
  lines.get(r.id)?.remove();
  editor.start(r.coords, r.color, async (coords) => {
    if (coords) {
      r.coords = coords;
      resnapForks(r);
      if (r.offline) r.offline.stale = true;
      await saveRoute(r);
      void refreshGauges();
      void refreshNav();
    }
    renderRoutes();
  });
}

// ---------- offline data bookkeeping ----------
/** Default corridor for new downloads: the river itself (±0.5 km). */
const DEFAULT_BUFFER_KM = 0.5;

function areaData(areas: OfflineArea[]) {
  const urls = new Set<string>();
  const osm = new Set<string>();
  for (const a of areas) {
    for (const u of corridorTiles(a.coords, a.bufferKm, OFFLINE_MIN_ZOOM, a.maxZoom)) urls.add(u);
    if (a.osm) for (const t of corridorTileCoords(a.coords, a.bufferKm, OSM_ZOOM, OSM_ZOOM)) osm.add(`${t.z}/${t.x}/${t.y}`);
  }
  return { urls, osm };
}

/** Delete a route's offline map and trail data, keeping anything another saved route still uses. */
async function removeOfflineData(r: Route) {
  if (!r.offline) return;
  const mine = areaData(offlineAreas(r));
  const keep = areaData(state.routes.filter((x) => x.id !== r.id).flatMap(offlineAreas));
  await Promise.all([
    deleteTiles([...mine.urls].filter((u) => !keep.urls.has(u))),
    deleteOsmTiles([...mine.osm].filter((k) => !keep.osm.has(k))),
  ]);
  delete r.offline;
  await saveRoute(r);
  renderOsm(await loadAllOsm());
  void refreshStorageInfo();
}

// ---------- details dialog ----------
const detailsDialog = $<HTMLDialogElement>('route-dialog');
const detailsForm = $<HTMLFormElement>('route-form');
const detailsField = (n: string) => detailsForm.elements.namedItem(n) as HTMLInputElement;
let detailsRoute: Route | null = null;

function fillGaugeChoices(r: Route) {
  const sel = $<HTMLSelectElement>('route-gauge');
  const near = gaugesNearRoute(r);
  sel.innerHTML =
    `<option value="">${near.length ? 'None' : navigator.onLine ? 'None (no gauges found nearby yet)' : 'None (go online to find gauges)'}</option>` +
    near
      .map(({ gauge: g, offKm }) => {
        const reading = g.latest['00060'] ?? g.latest['00065'];
        const param: GaugeParam = g.latest['00060'] ? '00060' : '00065';
        const now = reading ? ` · ${fmtValue(param, reading.value)}` : '';
        return `<option value="${g.id}">${escapeHtml(g.name)} (${offKm < 0.1 ? 'on route' : `${offKm.toFixed(1)} km away`}${now})</option>`;
      })
      .join('');
  // Suggest the nearest gauge on the river for a route that doesn't have one yet.
  sel.value = r.gaugeId ?? (near[0] && near[0].offKm <= 1 ? near[0].gauge.id : '');
}

function syncLevelUnits() {
  const unit = GAUGE_PARAMS[$<HTMLSelectElement>('route-level-param').value as GaugeParam].unit;
  for (const el of document.querySelectorAll<HTMLElement>('.level-unit')) el.textContent = unit;
}

function openDetails(r: Route, isNew: boolean) {
  detailsRoute = r;
  map.closePopup();
  $('route-dialog-title').textContent = isNew ? 'Name your route' : 'Edit route';
  detailsField('name').value = r.name;
  detailsField('color').value = r.color;
  detailsField('description').value = r.description;
  $('route-length').textContent = `${fmtMi(lengthMi(r.coords))} · mile 0 is where the line starts (use ⇄ to flip)`;
  fillGaugeChoices(r);
  const lv = r.levels;
  ($('route-level-param') as HTMLSelectElement).value = lv?.param ?? '00060';
  for (const k of ['low', 'high', 'flood'] as const) ($(`route-level-${k}`) as HTMLInputElement).value = lv?.[k]?.toString() ?? '';
  syncLevelUnits();
  detailsDialog.showModal();
  // Look for gauges near a route we haven't checked yet, then refresh the list.
  if (navigator.onLine) {
    void refreshGauges().then(() => {
      if (detailsRoute !== r) return;
      const sel = $<HTMLSelectElement>('route-gauge');
      const chosen = sel.value;
      fillGaugeChoices(r);
      if (chosen) sel.value = chosen; // keep what the user picked meanwhile
    });
  }
  if (isNew) detailsField('name').select();
}

// ---------- offline dialog ----------
const offlineDialog = $<HTMLDialogElement>('offline-dialog');
const bufferSelect = $<HTMLSelectElement>('offline-buffer');
const zoomSelect = $<HTMLSelectElement>('offline-zoom');
const osmCheckbox = $<HTMLInputElement>('offline-osm');
const progressBar = $<HTMLProgressElement>('offline-progress');
const startBtn = $<HTMLButtonElement>('offline-start');
let offlineRoute: Route | null = null;
/** Lines to download: the route and its forks, or just a trip's section. */
let offlineLines: LatLng[][] = [];
let abort: AbortController | null = null;

function plannedTiles(_r: Route) {
  const urls = new Set<string>();
  for (const line of offlineLines) for (const u of corridorTiles(line, Number(bufferSelect.value), OFFLINE_MIN_ZOOM, Number(zoomSelect.value))) urls.add(u);
  return [...urls];
}

function plannedOsm(_r: Route) {
  if (!osmCheckbox.checked) return [];
  const seen = new Map<string, TileCoord>();
  for (const line of offlineLines) for (const t of corridorTileCoords(line, Number(bufferSelect.value), OSM_ZOOM, OSM_ZOOM)) seen.set(`${t.z}/${t.x}/${t.y}`, t);
  return [...seen.values()];
}

/** Rough average size of an OpenFreeMap z14 tile. */
const AVG_OSM_BYTES = 40_000;

function updateEstimate() {
  if (!offlineRoute) return;
  const n = plannedTiles(offlineRoute).length;
  const m = plannedOsm(offlineRoute).length;
  const tooMany = n > MAX_TILES || m > OFM_MAX_TILES;
  const osmPart = m ? ` + ${m.toLocaleString()} trail/park data tiles` : '';
  $('offline-estimate').textContent = tooMany
    ? `${n.toLocaleString()} map tiles${osmPart} is too large. Pick a smaller area or less detail.`
    : `${n.toLocaleString()} map tiles${osmPart} · about ${fmtBytes(n * AVG_TILE_BYTES + m * AVG_OSM_BYTES)} (anything already saved is skipped)`;
  startBtn.disabled = tooMany;
}

/** Offline download for a route (and its forks), or with `section` just that part of it. */
export function openOffline(r: Route, section?: { coords: LatLng[]; label: string }) {
  offlineRoute = r;
  offlineLines = section ? [section.coords] : allLines(r);
  map.closePopup();
  $('offline-title').textContent = section ? `Save ${section.label} for offline` : `Save “${r.name}” for offline`;
  bufferSelect.value = String(r.offline?.bufferKm ?? DEFAULT_BUFFER_KM);
  $('offline-delete').hidden = !r.offline;
  zoomSelect.value = String(r.offline?.maxZoom ?? USGS_MAX_ZOOM);
  progressBar.hidden = true;
  $('offline-status').textContent = r.offline ? `Last saved: ${offlineLabel(r)}` : '';
  startBtn.textContent = 'Download';
  updateEstimate();
  offlineDialog.showModal();
  if (r.offline) {
    const keys = offlineAreas(r)
      .filter((a) => a.osm)
      .flatMap((a) => corridorTileCoords(a.coords, a.bufferKm, OSM_ZOOM, OSM_ZOOM))
      .map((t) => `${t.z}/${t.x}/${t.y}`);
    void outdatedOsmCount(keys).then((n) => {
      if (n && offlineRoute === r && !abort) {
        $('offline-status').textContent =
          'Trail & park data for this route was saved by an older version. Tap Download to update it (adds city parks and more parking).';
      }
    });
  }
}

async function runDownload() {
  const r = offlineRoute;
  if (!r) return;
  if (abort) {
    abort.abort();
    return;
  }
  const urls = plannedTiles(r);
  const osmTiles = plannedOsm(r);
  const controller = (abort = new AbortController());
  const status = (msg: string) => ($('offline-status').textContent = msg);
  startBtn.textContent = 'Cancel download';
  $('offline-delete').hidden = true;
  bufferSelect.disabled = zoomSelect.disabled = osmCheckbox.disabled = true;
  progressBar.hidden = false;
  progressBar.max = urls.length + osmTiles.length;
  progressBar.value = 0;
  // Ask the browser not to evict offline data under storage pressure.
  void navigator.storage?.persist?.();
  try {
    const tiles = await downloadTiles(
      urls,
      (p) => {
        progressBar.value = p.done;
        status(`Map: ${p.done.toLocaleString()} / ${p.total.toLocaleString()}…`);
      },
      controller.signal,
    );
    let osm: { total: number; failed: number; error?: string } | null = null;
    if (osmTiles.length && !controller.signal.aborted) {
      try {
        osm = await downloadOsm(
          osmTiles,
          (p) => {
            progressBar.value = urls.length + p.done;
            status(`Trails & parks: ${p.done.toLocaleString()} / ${p.total.toLocaleString()}…`);
          },
          controller.signal,
        );
      } catch (err) {
        if (!controller.signal.aborted) osm = { total: osmTiles.length, failed: osmTiles.length, error: (err as Error).message };
      }
      renderOsm(await loadAllOsm());
    }
    // One area per line (main line and each fork, or the trip section).
    const newAreas: OfflineArea[] = offlineLines.map((coords) => ({
      coords,
      bufferKm: Number(bufferSelect.value),
      maxZoom: Number(zoomSelect.value),
      osm: osmTiles.length > 0,
    }));
    const area = newAreas[0];
    const sameArea = (a: OfflineArea) => newAreas.some((n) => JSON.stringify(a) === JSON.stringify(n));
    if (controller.signal.aborted) {
      // Track the partial area so "Delete offline data" can still clean it up.
      r.offline = r.offline
        ? { ...r.offline, areas: [...offlineAreas(r).filter((a) => !sameArea(a)), ...newAreas] }
        : { areas: newAreas, bufferKm: area.bufferKm, maxZoom: area.maxZoom, tiles: 0, failed: 0, partial: true, downloadedAt: new Date().toISOString() };
      await saveRoute(r);
      rerenderOsm();
      status('Download cancelled. Everything saved so far is kept.');
      return;
    }
    r.offline = {
      areas: [...offlineAreas(r).filter((a) => !sameArea(a)), ...newAreas],
      bufferKm: area.bufferKm,
      maxZoom: area.maxZoom,
      tiles: tiles.total,
      failed: tiles.failed,
      osmTiles: osm?.total,
      osmFailed: osm?.failed,
      downloadedAt: new Date().toISOString(),
    };
    await saveRoute(r);
    rerenderOsm();
    const problems = [
      tiles.failed && `${tiles.failed} map tile(s) failed`,
      osm?.error && `trail & park data unavailable (${osm.error})`,
      osm && !osm.error && osm.failed && `${osm.failed} trail/park tile(s) failed`,
    ].filter(Boolean);
    status(
      problems.length
        ? `Saved, but ${problems.join('; ')}. Tap Download again to fill the gaps.`
        : `Saved${osm ? ' map, trails & parks' : ' map'}. This route works offline now.`,
    );
  } catch (err) {
    status(`Download failed: ${(err as Error).message}`);
  } finally {
    abort = null;
    startBtn.textContent = 'Download';
    bufferSelect.disabled = zoomSelect.disabled = osmCheckbox.disabled = false;
    $('offline-delete').hidden = !r.offline;
    void refreshStorageInfo();
  }
}

export async function refreshStorageInfo() {
  const [tiles, osm, est] = await Promise.all([cachedTileCount(), osmTileCount(), navigator.storage?.estimate?.()]);
  $('storage-info').textContent =
    `Offline: ${tiles.toLocaleString()} map + ${osm.toLocaleString()} trail tiles` +
    (est?.usage ? ` · ${fmtBytes(est.usage)}` : '');
  $('clear-tiles').hidden = tiles + osm === 0;
}

// ---------- wiring ----------
export function initRoutes() {
  $('new-route').addEventListener('click', startNewRoute);
  $('route-level-param').addEventListener('change', syncLevelUnits);
  // New readings: refresh lists and colours.
  document.addEventListener('gauges-changed', () => renderRoutes());

  $('route-list').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]')?.dataset.id;
    const r = id && findRoute(id);
    if (!r) return;
    focusRoute(r);
    closeSidebarOnMobile();
  });

  // Fork popups: rename, redraw, delete.
  map.getContainer().addEventListener('click', async (e) => {
    const fb = (e.target as HTMLElement).closest<HTMLElement>('[data-fork-action]');
    if (!fb) return;
    const r = findRoute(fb.dataset.id ?? '');
    const f = r?.forks?.find((x) => x.id === fb.dataset.fork);
    if (!r || !f) return;
    map.closePopup();
    switch (fb.dataset.forkAction) {
      case 'rename': {
        const name = prompt('Fork name', f.name ?? '');
        if (name === null) return;
        f.name = name.trim() || undefined;
        return saveRoute(r);
      }
      case 'line':
        return drawFork(r, f);
      case 'delete':
        if (!confirm(`Delete the fork “${f.name || 'unnamed'}”? The rest of the route is kept.`)) return;
        r.forks = r.forks!.filter((x) => x.id !== f.id);
        return saveRoute(r);
    }
  });

  map.getContainer().addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-route-action]');
    const r = btn?.dataset.id ? findRoute(btn.dataset.id) : undefined;
    if (!btn || !r) return;
    switch (btn.dataset.routeAction) {
      case 'fork':
        return drawFork(r);
      case 'open':
        return focusRoute(r);
      case 'details':
        return openDetails(r, false);
      case 'line':
        return editLine(r);
      case 'share':
        return openShare(r);
      case 'report': {
        // Opens the report dialog (tracks, photos, features, and the line just for the report).
        const { openReportDialog } = await import('./reportDialog');
        return openReportDialog({ route: r });
      }
      case 'offline':
        return openOffline(r);
      case 'reverse':
        r.coords = [...r.coords].reverse();
        resnapForks(r);
        await saveRoute(r);
        map.closePopup();
        return focusRoute(r);
    }
  });

  detailsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!detailsRoute) return;
    detailsRoute.name = detailsField('name').value.trim() || detailsRoute.name;
    detailsRoute.color = detailsField('color').value;
    detailsRoute.description = detailsField('description').value.trim();
    detailsRoute.gaugeId = $<HTMLSelectElement>('route-gauge').value || undefined;
    const num = (id: string) => {
      const v = $<HTMLInputElement>(id).value.trim();
      return v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);
    };
    const levels = {
      param: $<HTMLSelectElement>('route-level-param').value as GaugeParam,
      low: num('route-level-low'),
      high: num('route-level-high'),
      flood: num('route-level-flood'),
    };
    detailsRoute.levels = levels.low != null || levels.high != null || levels.flood != null ? levels : undefined;
    await saveRoute(detailsRoute);
    document.dispatchEvent(new CustomEvent('gauges-changed'));
    detailsRoute = null;
    detailsDialog.close();
  });
  $('route-cancel-details').addEventListener('click', () => {
    detailsRoute = null;
    detailsDialog.close();
  });
  $('route-delete').addEventListener('click', async () => {
    const r = detailsRoute;
    const extra = r?.offline ? ' Its offline map data will be deleted too.' : '';
    if (!r || !confirm(`Delete route “${r.name}”? Points along it are kept.${extra}`)) return;
    await removeOfflineData(r);
    await del('routes', r.id);
    await detachFromRoute(r.id);
    await forgetNav(r.id);
    state.routes = state.routes.filter((x) => x.id !== r.id);
    detailsRoute = null;
    detailsDialog.close();
    renderRoutes();
  });

  bufferSelect.addEventListener('change', updateEstimate);
  osmCheckbox.addEventListener('change', updateEstimate);
  zoomSelect.addEventListener('change', updateEstimate);
  startBtn.addEventListener('click', runDownload);
  $('offline-delete').addEventListener('click', async () => {
    const r = offlineRoute;
    if (!r?.offline || abort) return;
    if (!confirm(`Delete offline map data for “${r.name}”? The route itself is kept.`)) return;
    await removeOfflineData(r);
    $('offline-delete').hidden = true;
    $('offline-status').textContent = 'Offline data deleted.';
  });
  $('offline-close').addEventListener('click', () => offlineDialog.close());
  offlineDialog.addEventListener('close', () => abort?.abort());

  $('clear-tiles').addEventListener('click', async () => {
    if (!confirm('Delete all downloaded offline maps and trail data? Your points and routes are kept.')) return;
    await Promise.all([clearTiles(), clearOsm()]);
    renderOsm([]);
    for (const r of state.routes) {
      if (!r.offline) continue;
      delete r.offline;
      await put('routes', r);
    }
    renderRoutes();
    void refreshStorageInfo();
  });
}
