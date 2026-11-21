import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { CATEGORIES, SEVERITY_CATEGORIES, type Category, type RiverPoint, type Severity } from './types';
import { deletePoint, listPoints, savePoint, savePoints } from './store';
import { fromGeoJSON, toGeoJSON } from './geojson';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- state ----------
let points: RiverPoint[] = [];
const markers = new Map<string, L.Marker>();
const visibleCategories = new Set<Category>(Object.keys(CATEGORIES) as Category[]);
let searchText = '';
let addMode = false;
/** Point being edited; `isNew` means it has not been saved yet. */
let editing: { point: RiverPoint; isNew: boolean } | null = null;

// ---------- map ----------
const map = L.map('map', { zoomControl: false }).setView([32.9, -83.4], 7); // Georgia
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
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
    m = L.marker([p.lat, p.lng], { draggable: true });
    m.on('dragend', async () => {
      const cur = points.find((x) => x.id === p.id);
      if (!cur) return;
      const { lat, lng } = m!.getLatLng();
      Object.assign(cur, { lat, lng, updatedAt: new Date().toISOString() });
      await savePoint(cur);
    });
    markers.set(p.id, m);
  }
  m.setLatLng([p.lat, p.lng]).setIcon(iconFor(p)).bindPopup(popupHtml(p));
}

function matches(p: RiverPoint): boolean {
  if (!visibleCategories.has(p.category)) return false;
  if (!searchText) return true;
  return `${p.name} ${p.description}`.toLowerCase().includes(searchText);
}

// ---------- rendering ----------
function render() {
  for (const p of points) {
    upsertMarker(p);
    const m = markers.get(p.id)!;
    if (matches(p)) m.addTo(map);
    else m.remove();
  }
  for (const [id, m] of markers) {
    if (!points.some((p) => p.id === id)) {
      m.remove();
      markers.delete(id);
    }
  }
  renderList();
}

function renderList() {
  const list = $('point-list');
  const shown = points
    .filter(matches)
    .sort((a, b) => (a.riverMile ?? Infinity) - (b.riverMile ?? Infinity) || a.name.localeCompare(b.name));
  list.innerHTML = shown.length
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

// ---------- editor ----------
const dialog = $<HTMLDialogElement>('editor');
const form = $<HTMLFormElement>('editor-form');
const categorySelect = form.elements.namedItem('category') as HTMLSelectElement;
categorySelect.innerHTML = Object.entries(CATEGORIES)
  .map(([k, c]) => `<option value="${k}">${c.icon} ${c.label}</option>`)
  .join('');

function syncSeverityVisibility() {
  $('severity-row').hidden = !SEVERITY_CATEGORIES.includes(categorySelect.value as Category);
}
categorySelect.addEventListener('change', syncSeverityVisibility);

function openEditor(point: RiverPoint, isNew: boolean) {
  editing = { point, isNew };
  map.closePopup();
  $('editor-title').textContent = isNew ? 'New point' : 'Edit point';
  const f = form.elements as unknown as Record<string, HTMLInputElement>;
  f.name.value = point.name;
  f.category.value = point.category;
  f.severity.value = point.severity ?? '';
  f.riverMile.value = point.riverMile?.toString() ?? '';
  f.description.value = point.description;
  $('editor-coords').textContent = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  $('editor-delete').hidden = isNew;
  syncSeverityVisibility();
  dialog.showModal();
}

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
    severity: SEVERITY_CATEGORIES.includes(category) ? ((fd.get('severity') as Severity) || undefined) : undefined,
    updatedAt: new Date().toISOString(),
  };
  await savePoint(p);
  const i = points.findIndex((x) => x.id === p.id);
  if (i >= 0) points[i] = p;
  else points.push(p);
  editing = null;
  dialog.close();
  render();
});

$('editor-cancel').addEventListener('click', () => {
  editing = null;
  dialog.close();
});

$('editor-delete').addEventListener('click', async () => {
  if (!editing || !confirm(`Delete “${editing.point.name}”?`)) return;
  await deletePoint(editing.point.id);
  points = points.filter((p) => p.id !== editing!.point.id);
  editing = null;
  dialog.close();
  render();
});

// ---------- add mode ----------
function setAddMode(on: boolean) {
  addMode = on;
  $('hint').hidden = !on;
  map.getContainer().classList.toggle('adding', on);
}
$('add-point').addEventListener('click', () => setAddMode(!addMode));
$('cancel-add').addEventListener('click', () => setAddMode(false));

map.on('click', (e: L.LeafletMouseEvent) => {
  if (!addMode) return;
  setAddMode(false);
  const now = new Date().toISOString();
  openEditor(
    {
      id: crypto.randomUUID(),
      name: '',
      category: 'hazard',
      description: '',
      lat: e.latlng.lat,
      lng: e.latlng.lng,
      createdAt: now,
      updatedAt: now,
    },
    true,
  );
});

// Edit button inside popups
map.getContainer().addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-edit]')?.dataset.edit;
  const p = id && points.find((x) => x.id === id);
  if (p) openEditor({ ...p }, false);
});

// ---------- sidebar ----------
$('toggle-sidebar').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-open');
  setTimeout(() => map.invalidateSize(), 250);
});

$('point-list').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]')?.dataset.id;
  const m = id && markers.get(id);
  if (!m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 14));
  m.openPopup();
  if (window.matchMedia('(max-width: 720px)').matches) document.body.classList.remove('sidebar-open');
});

$('filters').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const cat = input.value as Category;
  if (input.checked) visibleCategories.add(cat);
  else visibleCategories.delete(cat);
  render();
});

$<HTMLInputElement>('search').addEventListener('input', (e) => {
  searchText = (e.target as HTMLInputElement).value.trim().toLowerCase();
  render();
});

// ---------- import / export ----------
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(toGeoJSON(points), null, 2)], { type: 'application/geo+json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `river-guide-${new Date().toISOString().slice(0, 10)}.geojson`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$<HTMLInputElement>('import').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const imported = fromGeoJSON(JSON.parse(await file.text()));
    await savePoints(imported);
    const byId = new Map(points.map((p) => [p.id, p]));
    for (const p of imported) byId.set(p.id, p);
    points = [...byId.values()];
    render();
    if (imported.length) map.fitBounds(L.latLngBounds(imported.map((p) => [p.lat, p.lng])), { padding: [40, 40] });
    alert(`Imported ${imported.length} point(s).`);
  } catch (err) {
    alert(`Import failed: ${(err as Error).message}`);
  }
});

// ---------- geolocation ----------
let youAreHere: L.CircleMarker | null = null;
$('locate').addEventListener('click', () => map.locate({ setView: true, maxZoom: 15 }));
map.on('locationfound', (e: L.LocationEvent) => {
  youAreHere ??= L.circleMarker(e.latlng, { radius: 8, color: '#fff', weight: 2, fillColor: '#1e88e5', fillOpacity: 1 });
  youAreHere.setLatLng(e.latlng).addTo(map);
});
map.on('locationerror', (e: L.ErrorEvent) => alert(`Couldn't get location: ${e.message}`));

// ---------- boot ----------
renderFilters();
points = await listPoints();
render();
