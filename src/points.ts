import L from 'leaflet';
import { map } from './map';
import { state } from './state';
import { del, put } from './store';
import { KM_PER_MI, lengthKm, nearestRoute, shapeAnchor } from './geo';
import {
  CATEGORIES,
  SEVERITY_CATEGORIES,
  type Category,
  type LatLng,
  type PointObservation,
  type PointShape,
  type RiverPoint,
  type Severity,
  type WaterLevel,
} from './types';
import {
  addObservation,
  editCurrent,
  fmtDay,
  fmtMonth,
  observationLabel,
  removeHistory,
  today,
} from './observations';
import { $, escapeHtml, getMode, setMode } from './ui';
import { mapFeatureAt, type MapFeature } from './mapFeatures';
import { landAt, landPopupHtml, landShown } from './land';
import { isOnWater } from './osm';
import { linkSummary, nearestRouteSpot, renderAccessLinks } from './access';
import { deletePhotos, importFiles, photosOf, setPhotoPoint, thumbUrl } from './photos';
import { dailyMean, fmtValue, freshGauge, levelFor, nearestGauge, readingSummary, routeGauge, LEVEL_LABELS } from './gauges';

const markers = new Map<string, L.Marker>();
/** Lines and areas drawn for points that have a shape. */
const shapes = new Map<string, L.Polyline<any> | L.Polygon>();
const visibleCategories = new Set<Category>(Object.keys(CATEGORIES) as Category[]);
let searchText = '';
/**
 * Point being edited; `isNew` means it has not been saved yet. In "observe"
 * mode the editor records a new dated observation instead of editing in place.
 */
let editing: { point: RiverPoint; isNew: boolean; mode: 'edit' | 'observe' } | null = null;
/** Photos to attach when the editor is saved, and attached ones to detach. */
let pendingPhotos: string[] = [];
let detachPhotos: string[] = [];

function iconFor(p: RiverPoint): L.DivIcon {
  const c = CATEGORIES[p.category];
  const sev = p.severity ? ` sev-${p.severity}` : '';
  return L.divIcon({
    className: '',
    html: `<div class="pin${sev}" style="--pin:${c.color}"><span>${c.icon}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
  });
}

function popupHtml(p: RiverPoint): string {
  const c = CATEGORIES[p.category];
  const meta = [c.label, p.severity && `severity: ${p.severity}`, p.riverMile != null && `mile ${p.riverMile}`]
    .filter(Boolean)
    .join(' · ');
  return `
    <div class="popup">
      <strong>${escapeHtml(p.name)}</strong>
      <div class="popup-meta">${escapeHtml(meta)}</div>
      ${p.observedAt || p.waterLevel || p.gauge ? `<div class="obs-label">Observed ${escapeHtml(observationLabel({ ...p, recordedAt: p.updatedAt }))}</div>` : ''}
      ${p.description ? `<p>${escapeHtml(p.description).replace(/\n/g, '<br>')}</p>` : ''}
      ${historyHtml(p)}
      ${photoStrip(p.id)}
      <div class="popup-updated">Updated ${new Date(p.updatedAt).toLocaleDateString([], { dateStyle: 'medium' })}</div>
      <div class="popup-actions">
        <button class="btn small" data-edit="${p.id}">Edit</button>
        <button class="btn small" data-observe="${p.id}">+ New observation</button>
      </div>
    </div>`;
}

/** Earlier observations, newest first (up to 4 in a popup). */
function historyHtml(p: RiverPoint): string {
  const h = p.history ?? [];
  if (!h.length) return '';
  const short = (s: string) => (s.length > 90 ? `${s.slice(0, 88)}…` : s);
  const rows = h
    .slice(0, 4)
    .map((o) => {
      const sev = o.severity ? ` <em class="sev-${o.severity}">${o.severity}</em>` : '';
      return `<li><span class="when">${escapeHtml(observationLabel(o) || 'Undated')}</span>${sev}${o.description ? ` — ${escapeHtml(short(o.description))}` : ''}</li>`;
    })
    .join('');
  const more = h.length > 4 ? `<li class="muted">+${h.length - 4} more (open Edit to see all)</li>` : '';
  return `<div class="history-title">Earlier observations</div><ul class="history-list">${rows}${more}</ul>`;
}

function photoStrip(pointId: string): string {
  const photos = photosOf(pointId);
  if (!photos.length) return '';
  const imgs = photos
    .slice(0, 4)
    .map((ph) => `<img src="${thumbUrl(ph)}" alt="" data-view-photo="${ph.id}" />`)
    .join('');
  return `<div class="photo-strip">${imgs}${photos.length > 4 ? `<span>+${photos.length - 4}</span>` : ''}</div>`;
}

function upsertShape(p: RiverPoint) {
  const old = shapes.get(p.id);
  if (!p.shape) {
    old?.remove();
    shapes.delete(p.id);
    return;
  }
  const c = CATEGORIES[p.category];
  const style: L.PathOptions = p.shape.kind === 'area'
    ? { color: c.color, weight: 2, opacity: 0.9, fillColor: c.color, fillOpacity: 0.18 }
    : { color: c.color, weight: 5, opacity: 0.85, lineCap: 'round' };
  if (old && (old instanceof L.Polygon) === (p.shape.kind === 'area')) {
    old.setLatLngs(p.shape.coords).setStyle(style);
    return;
  }
  old?.remove();
  const layer = p.shape.kind === 'area' ? L.polygon(p.shape.coords, style) : L.polyline(p.shape.coords, style);
  // Same popup as the marker, but not while drawing or placing something.
  layer.on('click', (e: L.LeafletMouseEvent) => {
    if (getMode() !== 'idle') return;
    L.DomEvent.stopPropagation(e);
    const cur = state.points.find((x) => x.id === p.id);
    if (cur) L.popup({ maxWidth: 280 }).setLatLng(e.latlng).setContent(popupHtml(cur)).openOn(map);
  });
  shapes.set(p.id, layer);
}

function upsertMarker(p: RiverPoint) {
  upsertShape(p);
  let m = markers.get(p.id);
  if (!m) {
    const marker = L.marker([p.lat, p.lng], { draggable: true });
    marker.on('dragend', async () => {
      const cur = state.points.find((x) => x.id === p.id);
      if (!cur) return;
      const { lat, lng } = marker.getLatLng();
      // Dragging the marker of a shaped point moves the whole shape with it.
      if (cur.shape) {
        const dLat = lat - cur.lat;
        const dLng = lng - cur.lng;
        cur.shape = { ...cur.shape, coords: cur.shape.coords.map(([a, b]) => [a + dLat, b + dLng] as LatLng) };
      }
      Object.assign(cur, { lat, lng, updatedAt: new Date().toISOString() });
      await put('points', cur);
      upsertShape(cur);
      if (matches(cur)) shapes.get(cur.id)?.addTo(map);
    });
    markers.set(p.id, marker);
    m = marker;
  }
  // Popup content is built when opened, so newly attached photos always show.
  m.setLatLng([p.lat, p.lng])
    .setIcon(iconFor(p))
    .bindPopup(() => popupHtml(state.points.find((x) => x.id === p.id) ?? p), { maxWidth: 280 });
}

function matches(p: RiverPoint): boolean {
  if (!visibleCategories.has(p.category)) return false;
  if (!searchText) return true;
  const past = (p.history ?? []).map((o) => o.description).join(' ');
  return `${p.name} ${p.description} ${past}`.toLowerCase().includes(searchText);
}

export function renderPoints() {
  for (const p of state.points) {
    upsertMarker(p);
    const m = markers.get(p.id)!;
    const shape = shapes.get(p.id);
    if (matches(p)) {
      shape?.addTo(map);
      m.addTo(map);
    } else {
      m.remove();
      shape?.remove();
    }
  }
  for (const [id, m] of markers) {
    if (!state.points.some((p) => p.id === id)) {
      m.remove();
      markers.delete(id);
      shapes.get(id)?.remove();
      shapes.delete(id);
    }
  }
  renderList();
  renderAccessLinks();
}

function renderList() {
  const shown = state.points
    .filter(matches)
    .sort((a, b) => (a.riverMile ?? Infinity) - (b.riverMile ?? Infinity) || a.name.localeCompare(b.name));
  $('point-list').innerHTML = shown.length
    ? shown
        .map((p) => {
          const c = CATEGORIES[p.category];
          return `<li data-id="${p.id}">
            <span class="dot" style="background:${c.color}">${c.icon}</span>
            <span class="li-text"><strong>${escapeHtml(p.name)}</strong>
              <small>${c.label}${p.riverMile != null ? ` · mile ${p.riverMile}` : ''}${p.observedAt ? ` · ${fmtMonth(p.observedAt)}` : ''}</small></span>
          </li>`;
        })
        .join('')
    : `<li class="empty">No points yet. Use “+ Add point” to create one.</li>`;
}

function renderFilters() {
  $('filters').innerHTML = (Object.entries(CATEGORIES) as [Category, (typeof CATEGORIES)[Category]][])
    .map(
      ([key, c]) => `<label class="chip" style="--pin:${c.color}">
        <input type="checkbox" value="${key}" ${visibleCategories.has(key) ? 'checked' : ''} />
        ${c.icon} ${c.label}</label>`,
    )
    .join('');
}

export function focusPoint(id: string) {
  const m = markers.get(id);
  if (!m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 14));
  m.openPopup();
}

// ---------- editor ----------
const dialog = $<HTMLDialogElement>('editor');
const form = $<HTMLFormElement>('editor-form');
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

/** Access points: where it meets a route, with buttons to change that. */
function syncAccessRow() {
  const access = field('category').value === 'access';
  $('access-row').hidden = !access;
  if (!access || !editing) return;
  const link = editing.point.routeLink;
  $('access-summary').textContent = linkSummary(editing.point);
  $('access-detach').hidden = !!link && 'detached' in link;
  $('access-auto').hidden = !link;
}

/** Close the editor for something on the map, then reopen it with what had been typed. */
function aside(): () => void {
  const typed = new FormData(form);
  const e = editing;
  dialog.close();
  return () => {
    editing = e;
    for (const [k, v] of typed.entries()) {
      const el = form.elements.namedItem(k) as HTMLInputElement | null;
      if (el && typeof v === 'string') el.value = v;
    }
    syncShapeControls();
    syncAccessRow();
    syncSeverityVisibility();
    dialog.showModal();
  };
}

let resumeEditor: (() => void) | null = null;
function startPick() {
  resumeEditor = aside();
  setMode('pick');
  $('pick-hint').hidden = false;
}
function endPick() {
  setMode('idle');
  $('pick-hint').hidden = true;
  const resume = resumeEditor;
  resumeEditor = null;
  resume?.();
}

function syncSeverityVisibility() {
  $('severity-row').hidden = !SEVERITY_CATEGORIES.includes(field('category').value as Category);
}

function renderEditorPhotos() {
  if (!editing) return;
  const ids = [
    ...photosOf(editing.point.id)
      .map((ph) => ph.id)
      .filter((id) => !detachPhotos.includes(id)),
    ...pendingPhotos,
  ];
  $('editor-photos').innerHTML = ids
    .map((id) => {
      const ph = state.photos.find((x) => x.id === id);
      return ph
        ? `<span class="editor-photo"><img src="${thumbUrl(ph)}" alt="" data-view-photo="${id}" />
            <button type="button" class="remove" data-remove-photo="${id}" aria-label="Remove photo">×</button></span>`
        : '';
    })
    .join('');
}

function renderEditorHistory() {
  if (!editing) return;
  const h = editing.point.history ?? [];
  $('editor-history').innerHTML = h.length
    ? `<div class="history-title">Earlier observations (${h.length})</div><ul class="history-list">${h
        .map(
          (o, i) => `<li><span class="when">${escapeHtml(observationLabel(o, 'day') || 'Undated')}</span>${
            o.severity ? ` <em class="sev-${o.severity}">${o.severity}</em>` : ''
          }${o.description ? ` — ${escapeHtml(o.description)}` : ''}
          <button type="button" class="link danger-link" data-remove-obs="${i}">Delete</button></li>`,
        )
        .join('')}</ul>`
    : '';
}

/**
 * The gauge for a point: its route's gauge (or the route's nearest), else the
 * nearest gauge to the point itself.
 */
function gaugeForPoint(p: RiverPoint) {
  const hit = nearestRoute(state.routes, [p.lat, p.lng]);
  const route = hit && hit.offKm <= 2 ? hit.route : undefined;
  const rg = route ? routeGauge(route) : null;
  return { route, gauge: rg?.gauge ?? nearestGauge(p.lat, p.lng) };
}

/** Fill "Gauge reading" (and water level, if the route has ranges) for the observation date. */
async function fillFromGauge(opts: { quiet?: boolean } = {}) {
  if (!editing) return;
  const p = editing.point;
  const hint = $('gauge-hint');
  const found = gaugeForPoint(p);
  if (!found.gauge) {
    if (!opts.quiet) hint.textContent = navigator.onLine ? 'No USGS gauge found near this point.' : 'No saved gauge data near this point (go online).';
    return;
  }
  const date = field('observedAt').value;
  const isToday = !date || date === today();
  const route = found.route;
  const levelParam = route?.levels?.param;
  let text: string;
  let levelValue: number | undefined;
  if (isToday) {
    const g = (await freshGauge(found.gauge.id)) ?? found.gauge;
    const time = g.latest['00060']?.time ?? g.latest['00065']?.time;
    // Quiet pre-fill only uses readings from the last 3 hours.
    if (opts.quiet && (!time || Date.now() - Date.parse(time) > 3 * 3_600_000)) return;
    text = readingSummary(g);
    levelValue = levelParam ? g.latest[levelParam]?.value : undefined;
  } else {
    if (!navigator.onLine) {
      if (!opts.quiet) hint.textContent = 'Past readings need a connection.';
      return;
    }
    hint.textContent = 'Looking up that day…';
    const param = levelParam ?? (found.gauge.latest['00060'] ? '00060' : '00065');
    const mean = await dailyMean(found.gauge.id, param, date).catch(() => null);
    if (mean == null) {
      hint.textContent = 'No reading for that day.';
      return;
    }
    text = `${fmtValue(param, mean)} daily mean at ${found.gauge.name}`;
    levelValue = levelParam === param ? mean : undefined;
  }
  field('gauge').value = text;
  const level = levelFor(route?.levels, levelValue);
  if (level) field('waterLevel').value = level;
  hint.textContent = `Filled from USGS${level ? ` · water level from “${route!.name}” ranges (${LEVEL_LABELS[level].label})` : ''}${opts.quiet ? ' · clear it if not wanted' : ''}`;
}

function openEditor(point: RiverPoint, isNew: boolean, photoIds: string[] = [], mode: 'edit' | 'observe' = 'edit') {
  editing = { point, isNew, mode };
  pendingPhotos = photoIds;
  detachPhotos = [];
  renderEditorPhotos();
  renderEditorHistory();
  map.closePopup();
  const observing = mode === 'observe';
  $('editor-title').textContent = observing ? `New observation · ${point.name}` : isNew ? 'New point' : 'Edit point';
  $('obs-legend').textContent = observing
    ? 'What you saw today (the previous observation moves to history)'
    : point.observedAt
      ? `Current observation (${fmtDay(point.observedAt)})`
      : 'What you saw';
  field('name').value = point.name;
  field('category').value = point.category;
  field('severity').value = point.severity ?? '';
  field('riverMile').value = point.riverMile?.toString() ?? '';
  field('description').value = point.description;
  // A new observation starts from today's date and blank conditions, with the
  // last description and severity to adjust rather than retype.
  field('observedAt').value = observing || isNew ? today() : (point.observedAt ?? '');
  field('waterLevel').value = observing ? '' : (point.waterLevel ?? '');
  field('gauge').value = observing ? '' : (point.gauge ?? '');
  $('gauge-hint').textContent = '';
  // Recording conditions today: pre-fill from a recent gauge reading.
  if ((observing || isNew) && !field('gauge').value) void fillFromGauge({ quiet: true });
  $('editor-save').textContent = observing ? 'Save observation' : 'Save';
  $('editor-save-new').hidden = isNew || observing;
  $('mile-hint').textContent = '';
  $('editor-coords').textContent = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  $('editor-delete').hidden = isNew;
  field('shapeKind').value = point.shape?.kind ?? '';
  syncShapeControls();
  syncAccessRow();
  syncSeverityVisibility();
  dialog.showModal();
}

// ---------- shapes in the editor ----------
const shapeLabel = (s?: PointShape) =>
  !s ? '' : s.kind === 'line' ? `Line, ${(lengthKm(s.coords) * 1000).toFixed(0)} m long` : `Area with ${s.coords.length} corners`;

function syncShapeControls() {
  const kind = field('shapeKind').value as '' | 'line' | 'area';
  const shape = editing?.point.shape;
  const btn = $<HTMLButtonElement>('editor-draw');
  btn.hidden = !kind;
  btn.textContent = shape && shape.kind === kind ? 'Redraw' : 'Draw';
  $('shape-hint').textContent = shape && shape.kind === kind ? shapeLabel(shape) : kind ? 'Not drawn yet' : '';
}

/** Draw (or redraw) the point's line or area on the map, then come back to the editor. */
async function drawShape() {
  if (!editing) return;
  const kind = field('shapeKind').value as 'line' | 'area';
  // Keep what's been typed so far: it's restored when the editor reopens.
  const typed = new FormData(form);
  const { editor } = await import('./routes');
  const e = editing;
  const existing = e.point.shape?.kind === kind ? e.point.shape.coords : [];
  dialog.close();
  editor.start(
    existing,
    CATEGORIES[(typed.get('category') as Category) ?? e.point.category]?.color ?? '#1565c0',
    (coords) => {
      editing = e;
      if (coords && coords.length >= (kind === 'area' ? 3 : 2)) {
        const shape: PointShape = { kind, coords };
        const [lat, lng] = shapeAnchor(kind, coords);
        editing.point = { ...editing.point, shape, lat, lng };
        $('editor-coords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      }
      for (const [k, v] of typed.entries()) {
        const el = form.elements.namedItem(k) as HTMLInputElement | null;
        if (el && typeof v === 'string') el.value = v;
      }
      syncShapeControls();
      dialog.showModal();
    },
    {
      hint: kind === 'area' ? 'Tap around the outline. It closes up by itself.' : 'Tap along the line.',
      format: (km) => (kind === 'area' ? `${Math.round(km * 1000)} m around` : `${Math.round(km * 1000)} m`),
      dashArray: kind === 'area' ? '6 4' : '',
    },
  );
}

/** Open the editor for a new, unsaved point (e.g. converted from an OSM feature). */
export function openNewPoint(
  init: Pick<RiverPoint, 'lat' | 'lng' | 'name' | 'category' | 'description'> & Partial<Pick<RiverPoint, 'shape'>>,
  opts: { photoIds?: string[] } = {},
) {
  const now = new Date().toISOString();
  // Points close to a route get their river mile filled in automatically.
  const hit = nearestRoute(state.routes, [init.lat, init.lng]);
  const riverMile = hit && hit.offKm <= 0.5 ? Math.round((hit.alongKm / KM_PER_MI) * 10) / 10 : undefined;
  openEditor({ id: crypto.randomUUID(), createdAt: now, updatedAt: now, riverMile, ...init }, true, opts.photoIds);
  if (hit && riverMile != null) $('mile-hint').textContent = `From “${hit.route.name}”`;
}

export function cancelAddPoint() {
  if (getMode() !== 'add-point') return;
  setMode('idle');
  $('hint').hidden = true;
}

export function initPoints() {
  renderFilters();
  field('category').innerHTML = Object.entries(CATEGORIES)
    .map(([k, c]) => `<option value="${k}">${c.icon} ${c.label}</option>`)
    .join('');
  field('category').addEventListener('change', () => {
    syncSeverityVisibility();
    syncAccessRow();
  });
  $('access-detach').addEventListener('click', () => {
    if (!editing) return;
    editing.point = { ...editing.point, routeLink: { detached: true } };
    syncAccessRow();
  });
  $('access-auto').addEventListener('click', () => {
    if (!editing) return;
    const { routeLink: _r, ...rest } = editing.point;
    editing.point = rest;
    syncAccessRow();
  });
  $('access-pick').addEventListener('click', startPick);
  $('cancel-pick').addEventListener('click', endPick);
  map.on('click', (e: L.LeafletMouseEvent) => {
    if (getMode() !== 'pick' || !editing) return;
    const spot = nearestRouteSpot([e.latlng.lat, e.latlng.lng]);
    if (!spot) return alert('Tap on a route line (within 300 m of it).');
    editing.point = { ...editing.point, routeLink: { routeId: spot.route.id, branch: spot.place.branch, km: spot.place.km } };
    endPick();
  });
  field('shapeKind').addEventListener('change', syncShapeControls);
  $('editor-draw').addEventListener('click', () => void drawShape());

  $('mile-from-route').addEventListener('click', () => {
    if (!editing) return;
    const hit = nearestRoute(state.routes, [editing.point.lat, editing.point.lng]);
    if (!hit || hit.offKm > 1) {
      $('mile-hint').textContent = 'No route within 1 km of this point.';
      return;
    }
    field('riverMile').value = (hit.alongKm / KM_PER_MI).toFixed(1);
    $('mile-hint').textContent = `From “${hit.route.name}” (${Math.round(hit.offKm * 1000)} m from the line)`;
  });

  async function saveFromForm(asNewObservation: boolean) {
    if (!editing) return;
    const fd = new FormData(form);
    const category = fd.get('category') as Category;
    const mile = String(fd.get('riverMile') ?? '').trim();
    const now = new Date().toISOString();
    let observedAt = String(fd.get('observedAt') ?? '') || undefined;
    // "Save as new observation" with the date untouched means "what I saw today".
    if (asNewObservation && editing.mode === 'edit' && observedAt === editing.point.observedAt) observedAt = today();
    const obs: PointObservation = {
      observedAt,
      description: String(fd.get('description') ?? '').trim(),
      severity: SEVERITY_CATEGORIES.includes(category) ? (fd.get('severity') as Severity) || undefined : undefined,
      waterLevel: (fd.get('waterLevel') as WaterLevel) || undefined,
      gauge: String(fd.get('gauge') ?? '').trim() || undefined,
      recordedAt: now,
    };
    const shapeKind = String(fd.get('shapeKind') ?? '');
    const keepShape = editing.point.shape && editing.point.shape.kind === shapeKind;
    const base: RiverPoint = {
      ...editing.point,
      name: String(fd.get('name')).trim(),
      category,
      riverMile: mile === '' ? undefined : Number(mile),
      shape: keepShape ? editing.point.shape : undefined,
      updatedAt: now,
    };
    const p = asNewObservation ? addObservation(base, obs) : editCurrent(base, obs);
    await put('points', p);
    const i = state.points.findIndex((x) => x.id === p.id);
    if (i >= 0) state.points[i] = p;
    else state.points.push(p);
    if (pendingPhotos.length) await setPhotoPoint(pendingPhotos, p.id);
    if (detachPhotos.length) await setPhotoPoint(detachPhotos, undefined);
    pendingPhotos = detachPhotos = [];
    editing = null;
    dialog.close();
    renderPoints();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void saveFromForm(editing?.mode === 'observe');
  });
  $('gauge-fill').addEventListener('click', () => void fillFromGauge());
  $('editor-save-new').addEventListener('click', () => {
    if (form.reportValidity()) void saveFromForm(true);
  });
  $('editor-history').addEventListener('click', (e) => {
    const idx = (e.target as HTMLElement).closest<HTMLElement>('[data-remove-obs]')?.dataset.removeObs;
    if (idx == null || !editing || !confirm('Delete this earlier observation? (Takes effect when you save.)')) return;
    editing.point = removeHistory(editing.point, Number(idx));
    renderEditorHistory();
  });

  $('editor-cancel').addEventListener('click', () => {
    editing = null;
    pendingPhotos = detachPhotos = [];
    dialog.close();
  });

  $<HTMLInputElement>('editor-photo-input').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!editing || !files.length) return;
    const added = await importFiles(files);
    pendingPhotos = [...pendingPhotos, ...added.map((ph) => ph.id)];
    renderEditorPhotos();
  });

  $('editor-photos').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-remove-photo]')?.dataset.removePhoto;
    if (!id || !editing) return;
    // Removed photos go back to "Photos to review" rather than being deleted.
    if (pendingPhotos.includes(id)) pendingPhotos = pendingPhotos.filter((x) => x !== id);
    else detachPhotos = [...detachPhotos, id];
    renderEditorPhotos();
  });

  $('editor-delete').addEventListener('click', async () => {
    if (!editing) return;
    const id = editing.point.id;
    const photoIds = photosOf(id).map((ph) => ph.id);
    const extra = photoIds.length ? ` Its ${photoIds.length} photo(s) will be deleted too.` : '';
    if (!confirm(`Delete “${editing.point.name}”?${extra}`)) return;
    await deletePhotos(photoIds);
    await del('points', id);
    state.points = state.points.filter((p) => p.id !== id);
    editing = null;
    dialog.close();
    renderPoints();
  });

  // Add mode
  $('add-point').addEventListener('click', () => {
    if (getMode() === 'route' || getMode() === 'place') return; // finish that first
    if (getMode() === 'add-point') return cancelAddPoint();
    setMode('add-point');
    $('hint').hidden = false;
  });
  $('cancel-add').addEventListener('click', cancelAddPoint);

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (getMode() !== 'add-point') return;
    cancelAddPoint();
    openNewPoint({ name: '', category: 'hazard', description: '', lat: e.latlng.lat, lng: e.latlng.lng });
  });

  // Tapping an island or bridge on the base map offers to make it a point (with its outline or line).
  let offered: MapFeature | null = null;
  let lookup = 0;
  map.on('click', async (e: L.LeafletMouseEvent) => {
    if (getMode() !== 'idle' || map.getZoom() < 12) return;
    // Taps on routes, tracks, shapes etc. are theirs, not the base map's.
    if ((e.originalEvent.target as Element | null)?.closest?.('.leaflet-interactive, .leaflet-marker-icon, .leaflet-popup')) return;
    const at: LatLng = [e.latlng.lat, e.latlng.lng];
    const mine = ++lookup;
    // Whose land is this? (Only near routes, where the public-land layer has data.)
    const land = landShown() ? landAt(at) : null;
    const f = map.getZoom() >= 13 ? await mapFeatureAt(at).catch(() => null) : null;
    if (mine !== lookup || getMode() !== 'idle') return;
    let landHtml = '';
    if (land?.length) landHtml = landPopupHtml(land);
    else if (land && f?.kind !== 'bridge') {
      // "Probably private" only on land, not out on the river.
      const onLand = f?.kind === 'island' || (await isOnWater(at).catch(() => undefined)) === false;
      if (mine !== lookup || getMode() !== 'idle') return;
      if (onLand) landHtml = landPopupHtml([]);
    }
    if (!f && !landHtml) return;
    offered = f;
    const featureHtml = f
      ? `<strong>${CATEGORIES[f.kind].icon} ${escapeHtml(f.name ?? (f.kind === 'island' ? 'Island' : 'Bridge'))}</strong>
          <div class="popup-meta">${f.kind === 'island' ? 'Island' : 'Bridge'} on the map (OpenStreetMap)</div>
          <div class="popup-actions"><button class="btn small primary" data-map-feature>Create ${f.kind} point</button></div>`
      : '';
    L.popup({ maxWidth: 280 })
      .setLatLng(e.latlng)
      .setContent(`<div class="popup">${featureHtml}${landHtml}</div>`)
      .openOn(map);
  });
  map.getContainer().addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-map-feature]') || !offered) return;
    const f = offered;
    offered = null;
    map.closePopup();
    const coords = f.kind === 'island' ? f.ring : f.line;
    const shape: PointShape = { kind: f.kind === 'island' ? 'area' : 'line', coords };
    const [lat, lng] = shapeAnchor(shape.kind, coords);
    openNewPoint({ name: f.name ?? '', category: f.kind, description: '', lat, lng, shape });
  });

  // Edit button inside popups
  map.getContainer().addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const editId = target.closest<HTMLElement>('[data-edit]')?.dataset.edit;
    const obsId = target.closest<HTMLElement>('[data-observe]')?.dataset.observe;
    const p = state.points.find((x) => x.id === (editId ?? obsId));
    if (p) openEditor({ ...p }, false, [], obsId ? 'observe' : 'edit');
  });

  $('point-list').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]')?.dataset.id;
    if (!id) return;
    focusPoint(id);
    closeSidebarOnMobile();
  });

  $('filters').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const cat = input.value as Category;
    if (input.checked) visibleCategories.add(cat);
    else visibleCategories.delete(cat);
    renderPoints();
  });

  $<HTMLInputElement>('search').addEventListener('input', (e) => {
    searchText = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderPoints();
  });
}

export function closeSidebarOnMobile() {
  if (window.matchMedia('(max-width: 720px)').matches) document.body.classList.remove('sidebar-open');
}
