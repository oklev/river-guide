import L from 'leaflet';
import { map } from './map';
import { state } from './state';
import { del, put } from './store';
import { KM_PER_MI, lengthMi, locateOnLine } from './geo';
import { RouteEditor } from './routeEditor';
import { cancelAddPoint, closeSidebarOnMobile } from './points';
import {
  AVG_TILE_BYTES,
  OFFLINE_MIN_ZOOM,
  USGS_MAX_ZOOM,
  cachedTileCount,
  clearTiles,
  corridorTiles,
  downloadTiles,
} from './tiles';
import { CATEGORIES, ROUTE_COLORS, type Route } from './types';
import { $, escapeHtml, fmtBytes, fmtMi, getMode } from './ui';

/** Above this, the download button is disabled; keeps a stray 50 km buffer from pulling gigabytes. */
const MAX_TILES = 20_000;
/** Points this close to a route are listed in its "along this route" section. */
const ALONG_KM = 0.5;

const lines = new Map<string, L.Polyline>();
const editor = new RouteEditor(map);
const findRoute = (id: string) => state.routes.find((r) => r.id === id);

// ---------- rendering ----------
function offlineLabel(r: Route): string {
  if (!r.offline) return 'Not saved for offline';
  if (r.offline.stale) return 'Offline map outdated (line changed)';
  return `Offline ✓ ${new Date(r.offline.downloadedAt).toLocaleDateString()}`;
}

function popupHtml(r: Route): string {
  const along = state.points
    .map((p) => ({ p, loc: locateOnLine(r.coords, [p.lat, p.lng]) }))
    .filter((x) => x.loc && x.loc.offKm <= ALONG_KM)
    .sort((a, b) => a.loc!.alongKm - b.loc!.alongKm)
    .slice(0, 15);
  const alongHtml = along.length
    ? `<ul class="along">${along
        .map(({ p, loc }) => {
          const c = CATEGORIES[p.category];
          const sev = p.severity ? ` <em class="sev-${p.severity}">${p.severity}</em>` : '';
          return `<li><span class="mi">${(loc!.alongKm / KM_PER_MI).toFixed(1)}</span>
            <span style="color:${c.color}">${c.icon}</span> ${escapeHtml(p.name)}${sev}</li>`;
        })
        .join('')}</ul>`
    : '';
  return `
    <div class="popup">
      <strong>${escapeHtml(r.name)}</strong>
      <div class="popup-meta">${fmtMi(lengthMi(r.coords))} · ${escapeHtml(offlineLabel(r))}</div>
      ${r.description ? `<p>${escapeHtml(r.description).replace(/\n/g, '<br>')}</p>` : ''}
      ${alongHtml}
      <div class="popup-actions">
        <button class="btn small" data-route-action="details" data-id="${r.id}">Edit</button>
        <button class="btn small" data-route-action="line" data-id="${r.id}">Edit line</button>
        <button class="btn small" data-route-action="reverse" data-id="${r.id}" title="Swap put-in and take-out">⇄</button>
        <button class="btn small primary" data-route-action="offline" data-id="${r.id}">Offline…</button>
      </div>
    </div>`;
}

function upsertLine(r: Route) {
  let line = lines.get(r.id);
  if (!line) {
    line = L.polyline([], { weight: 5, opacity: 0.85 });
    line.bindPopup(() => {
      const cur = findRoute(r.id);
      return cur ? popupHtml(cur) : '';
    }, { maxWidth: 320 });
    lines.set(r.id, line);
  }
  line.setLatLngs(r.coords).setStyle({ color: r.color }).addTo(map);
}

export function renderRoutes() {
  for (const r of state.routes) upsertLine(r);
  for (const [id, line] of lines) {
    if (!findRoute(id)) {
      line.remove();
      lines.delete(id);
    }
  }
  $('route-list').innerHTML = state.routes.length
    ? [...state.routes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (r) => `<li data-id="${r.id}">
            <span class="swatch" style="background:${r.color}"></span>
            <span class="li-text"><strong>${escapeHtml(r.name)}</strong>
              <small>${fmtMi(lengthMi(r.coords))} · ${escapeHtml(offlineLabel(r))}</small></span>
          </li>`,
        )
        .join('')
    : `<li class="empty">No routes yet. Use “+ New route” and tap along the river to trace one.</li>`;
}

function focusRoute(r: Route) {
  const line = lines.get(r.id);
  if (!line) return;
  map.fitBounds(line.getBounds(), { padding: [40, 40] });
  line.openPopup(line.getCenter());
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
    if (!coords) return;
    const now = new Date().toISOString();
    const r: Route = {
      id: crypto.randomUUID(),
      name: `Route ${state.routes.length + 1}`,
      description: '',
      color,
      coords,
      createdAt: now,
      updatedAt: now,
    };
    await saveRoute(r); // save right away so the traced line is never lost
    openDetails(r, true);
  });
}

function editLine(r: Route) {
  cancelAddPoint();
  lines.get(r.id)?.remove();
  editor.start(r.coords, r.color, async (coords) => {
    if (coords) {
      r.coords = coords;
      if (r.offline) r.offline.stale = true;
      await saveRoute(r);
    }
    renderRoutes();
  });
}

// ---------- details dialog ----------
const detailsDialog = $<HTMLDialogElement>('route-dialog');
const detailsForm = $<HTMLFormElement>('route-form');
const detailsField = (n: string) => detailsForm.elements.namedItem(n) as HTMLInputElement;
let detailsRoute: Route | null = null;

function openDetails(r: Route, isNew: boolean) {
  detailsRoute = r;
  map.closePopup();
  $('route-dialog-title').textContent = isNew ? 'Name your route' : 'Edit route';
  detailsField('name').value = r.name;
  detailsField('color').value = r.color;
  detailsField('description').value = r.description;
  $('route-length').textContent = `${fmtMi(lengthMi(r.coords))} · mile 0 is where the line starts (use ⇄ to flip)`;
  detailsDialog.showModal();
  if (isNew) detailsField('name').select();
}

// ---------- offline dialog ----------
const offlineDialog = $<HTMLDialogElement>('offline-dialog');
const bufferSelect = $<HTMLSelectElement>('offline-buffer');
const zoomSelect = $<HTMLSelectElement>('offline-zoom');
const progressBar = $<HTMLProgressElement>('offline-progress');
const startBtn = $<HTMLButtonElement>('offline-start');
let offlineRoute: Route | null = null;
let abort: AbortController | null = null;

function plannedTiles(r: Route) {
  return corridorTiles(r.coords, Number(bufferSelect.value), OFFLINE_MIN_ZOOM, Number(zoomSelect.value));
}

function updateEstimate() {
  if (!offlineRoute) return;
  const n = plannedTiles(offlineRoute).length;
  const tooMany = n > MAX_TILES;
  $('offline-estimate').textContent = tooMany
    ? `${n.toLocaleString()} tiles is too large. Pick a smaller area or less detail.`
    : `${n.toLocaleString()} map tiles · about ${fmtBytes(n * AVG_TILE_BYTES)} (tiles already saved are skipped)`;
  startBtn.disabled = tooMany;
}

function openOffline(r: Route) {
  offlineRoute = r;
  map.closePopup();
  $('offline-title').textContent = `Save “${r.name}” for offline`;
  bufferSelect.value = String(r.offline?.bufferKm ?? 2);
  zoomSelect.value = String(r.offline?.maxZoom ?? USGS_MAX_ZOOM);
  progressBar.hidden = true;
  $('offline-status').textContent = r.offline ? `Last saved: ${offlineLabel(r)}` : '';
  startBtn.textContent = 'Download';
  updateEstimate();
  offlineDialog.showModal();
}

async function runDownload() {
  const r = offlineRoute;
  if (!r) return;
  if (abort) {
    abort.abort();
    return;
  }
  const urls = plannedTiles(r);
  const controller = (abort = new AbortController());
  startBtn.textContent = 'Cancel download';
  bufferSelect.disabled = zoomSelect.disabled = true;
  progressBar.hidden = false;
  progressBar.max = urls.length;
  progressBar.value = 0;
  // Ask the browser not to evict offline data under storage pressure.
  void navigator.storage?.persist?.();
  try {
    const result = await downloadTiles(
      urls,
      (p) => {
        progressBar.value = p.done;
        $('offline-status').textContent = `Downloading ${p.done.toLocaleString()} / ${p.total.toLocaleString()}…`;
      },
      controller.signal,
    );
    if (controller.signal.aborted) {
      $('offline-status').textContent = 'Download cancelled. Tiles saved so far are kept.';
    } else {
      r.offline = {
        bufferKm: Number(bufferSelect.value),
        maxZoom: Number(zoomSelect.value),
        tiles: result.total,
        failed: result.failed,
        downloadedAt: new Date().toISOString(),
      };
      await saveRoute(r);
      $('offline-status').textContent = result.failed
        ? `Saved, but ${result.failed} tile(s) failed. Try again to fill the gaps.`
        : `Saved ${result.total.toLocaleString()} tiles. This route works offline now.`;
    }
  } catch (err) {
    $('offline-status').textContent = `Download failed: ${(err as Error).message}`;
  } finally {
    abort = null;
    startBtn.textContent = 'Download';
    bufferSelect.disabled = zoomSelect.disabled = false;
    void refreshStorageInfo();
  }
}

export async function refreshStorageInfo() {
  const [tiles, est] = await Promise.all([cachedTileCount(), navigator.storage?.estimate?.()]);
  $('storage-info').textContent =
    `Offline maps: ${tiles.toLocaleString()} tiles` + (est?.usage ? ` · ${fmtBytes(est.usage)} used` : '');
  $('clear-tiles').hidden = tiles === 0;
}

// ---------- wiring ----------
export function initRoutes() {
  $('new-route').addEventListener('click', startNewRoute);

  $('route-list').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]')?.dataset.id;
    const r = id && findRoute(id);
    if (!r) return;
    focusRoute(r);
    closeSidebarOnMobile();
  });

  map.getContainer().addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-route-action]');
    const r = btn?.dataset.id ? findRoute(btn.dataset.id) : undefined;
    if (!btn || !r) return;
    switch (btn.dataset.routeAction) {
      case 'details':
        return openDetails(r, false);
      case 'line':
        return editLine(r);
      case 'offline':
        return openOffline(r);
      case 'reverse':
        r.coords = [...r.coords].reverse();
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
    await saveRoute(detailsRoute);
    detailsRoute = null;
    detailsDialog.close();
  });
  $('route-cancel-details').addEventListener('click', () => {
    detailsRoute = null;
    detailsDialog.close();
  });
  $('route-delete').addEventListener('click', async () => {
    const r = detailsRoute;
    if (!r || !confirm(`Delete route “${r.name}”? Points along it are kept.`)) return;
    await del('routes', r.id);
    state.routes = state.routes.filter((x) => x.id !== r.id);
    detailsRoute = null;
    detailsDialog.close();
    renderRoutes();
  });

  bufferSelect.addEventListener('change', updateEstimate);
  zoomSelect.addEventListener('change', updateEstimate);
  startBtn.addEventListener('click', runDownload);
  $('offline-close').addEventListener('click', () => offlineDialog.close());
  offlineDialog.addEventListener('close', () => abort?.abort());

  $('clear-tiles').addEventListener('click', async () => {
    if (!confirm('Delete all downloaded offline maps? Your points and routes are kept.')) return;
    await clearTiles();
    for (const r of state.routes) {
      if (!r.offline) continue;
      delete r.offline;
      await put('routes', r);
    }
    renderRoutes();
    void refreshStorageInfo();
  });
}
