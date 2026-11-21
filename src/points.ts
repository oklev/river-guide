import L from 'leaflet';
import { map } from './map';
import { state } from './state';
import { del, put } from './store';
import { KM_PER_MI, nearestRoute } from './geo';
import { CATEGORIES, SEVERITY_CATEGORIES, type Category, type RiverPoint, type Severity } from './types';
import { $, escapeHtml, getMode, setMode } from './ui';

const markers = new Map<string, L.Marker>();
const visibleCategories = new Set<Category>(Object.keys(CATEGORIES) as Category[]);
let searchText = '';
/** Point being edited; `isNew` means it has not been saved yet. */
let editing: { point: RiverPoint; isNew: boolean } | null = null;

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
      ${p.description ? `<p>${escapeHtml(p.description).replace(/\n/g, '<br>')}</p>` : ''}
      <button class="btn small" data-edit="${p.id}">Edit</button>
    </div>`;
}

function upsertMarker(p: RiverPoint) {
  let m = markers.get(p.id);
  if (!m) {
    const marker = L.marker([p.lat, p.lng], { draggable: true });
    marker.on('dragend', async () => {
      const cur = state.points.find((x) => x.id === p.id);
      if (!cur) return;
      const { lat, lng } = marker.getLatLng();
      Object.assign(cur, { lat, lng, updatedAt: new Date().toISOString() });
      await put('points', cur);
    });
    markers.set(p.id, marker);
    m = marker;
  }
  m.setLatLng([p.lat, p.lng]).setIcon(iconFor(p)).bindPopup(popupHtml(p));
}

function matches(p: RiverPoint): boolean {
  if (!visibleCategories.has(p.category)) return false;
  if (!searchText) return true;
  return `${p.name} ${p.description}`.toLowerCase().includes(searchText);
}

export function renderPoints() {
  for (const p of state.points) {
    upsertMarker(p);
    const m = markers.get(p.id)!;
    if (matches(p)) m.addTo(map);
    else m.remove();
  }
  for (const [id, m] of markers) {
    if (!state.points.some((p) => p.id === id)) {
      m.remove();
      markers.delete(id);
    }
  }
  renderList();
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
              <small>${c.label}${p.riverMile != null ? ` · mile ${p.riverMile}` : ''}</small></span>
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

function syncSeverityVisibility() {
  $('severity-row').hidden = !SEVERITY_CATEGORIES.includes(field('category').value as Category);
}

function openEditor(point: RiverPoint, isNew: boolean) {
  editing = { point, isNew };
  map.closePopup();
  $('editor-title').textContent = isNew ? 'New point' : 'Edit point';
  field('name').value = point.name;
  field('category').value = point.category;
  field('severity').value = point.severity ?? '';
  field('riverMile').value = point.riverMile?.toString() ?? '';
  field('description').value = point.description;
  $('mile-hint').textContent = '';
  $('editor-coords').textContent = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  $('editor-delete').hidden = isNew;
  syncSeverityVisibility();
  dialog.showModal();
}

/** Open the editor for a new, unsaved point (e.g. converted from an OSM feature). */
export function openNewPoint(init: Pick<RiverPoint, 'lat' | 'lng' | 'name' | 'category' | 'description'>) {
  const now = new Date().toISOString();
  openEditor({ id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...init }, true);
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
  field('category').addEventListener('change', syncSeverityVisibility);

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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editing) return;
    const fd = new FormData(form);
    const category = fd.get('category') as Category;
    const mile = String(fd.get('riverMile') ?? '').trim();
    const p: RiverPoint = {
      ...editing.point,
      name: String(fd.get('name')).trim(),
      category,
      description: String(fd.get('description') ?? '').trim(),
      riverMile: mile === '' ? undefined : Number(mile),
      severity: SEVERITY_CATEGORIES.includes(category) ? (fd.get('severity') as Severity) || undefined : undefined,
      updatedAt: new Date().toISOString(),
    };
    await put('points', p);
    const i = state.points.findIndex((x) => x.id === p.id);
    if (i >= 0) state.points[i] = p;
    else state.points.push(p);
    editing = null;
    dialog.close();
    renderPoints();
  });

  $('editor-cancel').addEventListener('click', () => {
    editing = null;
    dialog.close();
  });

  $('editor-delete').addEventListener('click', async () => {
    if (!editing || !confirm(`Delete “${editing.point.name}”?`)) return;
    const id = editing.point.id;
    await del('points', id);
    state.points = state.points.filter((p) => p.id !== id);
    editing = null;
    dialog.close();
    renderPoints();
  });

  // Add mode
  $('add-point').addEventListener('click', () => {
    if (getMode() === 'route') return; // finish or cancel the route first
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

  // Edit button inside popups
  map.getContainer().addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-edit]')?.dataset.edit;
    const p = id && state.points.find((x) => x.id === id);
    if (p) openEditor({ ...p }, false);
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
