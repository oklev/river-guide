import L from 'leaflet';
import { map } from './map';
import { state } from './state';
import { del, put } from './store';
import { KM_PER_MI, lengthKm, locateOnLine } from './geo';
import { editor } from './routes';
import { cancelAddPoint, closeSidebarOnMobile } from './points';
import { PATH_KINDS, type LatLng, type PathKind, type Portage, type Route } from './types';
import { $, escapeHtml, fmtWalk, getMode } from './ui';

/** A new path attaches to the nearest route within this distance. */
const ATTACH_KM = 1;

const lines = new Map<string, L.Polyline>();
const findPortage = (id: string) => state.portages.find((p) => p.id === id);
export const portagesOf = (routeId: string) => state.portages.filter((p) => p.routeId === routeId);

const style = (kind: PathKind): L.PolylineOptions => ({
  color: PATH_KINDS[kind].color,
  weight: 5,
  opacity: 0.95,
  dashArray: '1 9', // dotted, so it reads as "on foot" next to solid river routes
  lineCap: 'round',
});

/** River mile where the path meets its route (its nearer end). */
export function portageMile(p: Portage, r: Route): number | null {
  const ends = [p.coords[0], p.coords[p.coords.length - 1]]
    .map((c) => locateOnLine(r.coords, c))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => a.offKm - b.offKm);
  return ends.length ? ends[0].alongKm / KM_PER_MI : null;
}

function nearestRouteId(coords: LatLng[]): string | undefined {
  let best: { id: string; off: number } | undefined;
  for (const r of state.routes) {
    for (const c of [coords[0], coords[coords.length - 1]]) {
      const loc = locateOnLine(r.coords, c);
      if (loc && loc.offKm <= ATTACH_KM && (!best || loc.offKm < best.off)) best = { id: r.id, off: loc.offKm };
    }
  }
  return best?.id;
}

// ---------- rendering ----------
function popupHtml(p: Portage): string {
  const k = PATH_KINDS[p.kind];
  const route = p.routeId ? state.routes.find((r) => r.id === p.routeId) : undefined;
  const mile = route ? portageMile(p, route) : null;
  const meta = [k.label, fmtWalk(lengthKm(p.coords)), route && `${route.name}${mile != null ? `, mile ${mile.toFixed(1)}` : ''}`]
    .filter(Boolean)
    .join(' · ');
  return `<div class="popup">
    <strong>${k.icon} ${escapeHtml(p.name)}</strong>
    <div class="popup-meta">${escapeHtml(meta)}</div>
    ${p.description ? `<p>${escapeHtml(p.description).replace(/\n/g, '<br>')}</p>` : ''}
    <div class="popup-actions">
      <button class="btn small" data-portage-action="details" data-id="${p.id}">Edit</button>
      <button class="btn small" data-portage-action="line" data-id="${p.id}">Edit line</button>
    </div>
  </div>`;
}

function upsertLine(p: Portage) {
  let line = lines.get(p.id);
  if (!line) {
    line = L.polyline([], style(p.kind));
    line.on('click', (e: L.LeafletMouseEvent) => {
      const cur = findPortage(p.id);
      if (cur && getMode() === 'idle') L.popup({ maxWidth: 300 }).setLatLng(e.latlng).setContent(popupHtml(cur)).openOn(map);
    });
    lines.set(p.id, line);
  }
  line.setLatLngs(p.coords).setStyle(style(p.kind)).addTo(map);
}

export function renderPortages() {
  for (const p of state.portages) upsertLine(p);
  for (const [id, line] of lines) {
    if (!findPortage(id)) {
      line.remove();
      lines.delete(id);
    }
  }
  const list = [...state.portages].sort((a, b) => a.name.localeCompare(b.name));
  $('portage-list').innerHTML = list
    .map((p) => {
      const k = PATH_KINDS[p.kind];
      const route = state.routes.find((r) => r.id === p.routeId);
      return `<li data-id="${p.id}">
        <span class="swatch dotted" style="--c:${k.color}"></span>
        <span class="li-text"><strong>${escapeHtml(p.name)}</strong>
          <small>${k.label} · ${fmtWalk(lengthKm(p.coords))}${route ? ` · ${escapeHtml(route.name)}` : ''}</small></span>
      </li>`;
    })
    .join('');
  $('portage-heading').hidden = list.length === 0;
}

async function savePortage(p: Portage) {
  p.updatedAt = new Date().toISOString();
  await put('portages', p);
  if (!findPortage(p.id)) state.portages.push(p);
  renderPortages();
  document.dispatchEvent(new CustomEvent('portages-changed'));
}

// ---------- drawing ----------
function startNewPortage() {
  if (getMode() === 'route') return;
  cancelAddPoint();
  closeSidebarOnMobile();
  editor.start(
    [],
    PATH_KINDS.portage.color,
    async (coords) => {
      if (!coords) return;
      const now = new Date().toISOString();
      const p: Portage = {
        id: crypto.randomUUID(),
        name: '',
        kind: 'portage',
        description: '',
        coords,
        routeId: nearestRouteId(coords),
        createdAt: now,
        updatedAt: now,
      };
      openDetails(p, true);
    },
    { hint: 'Tap along the path on land, from one end to the other', format: fmtWalk, dashArray: '1 9' },
  );
}

function editLine(p: Portage) {
  cancelAddPoint();
  lines.get(p.id)?.remove();
  editor.start(
    p.coords,
    PATH_KINDS[p.kind].color,
    async (coords) => {
      if (coords) {
        p.coords = coords;
        await savePortage(p);
      }
      renderPortages();
    },
    { format: fmtWalk, dashArray: '1 9' },
  );
}

// ---------- details dialog ----------
const dialog = () => $<HTMLDialogElement>('portage-dialog');
const form = () => $<HTMLFormElement>('portage-form');
const field = (n: string) => form().elements.namedItem(n) as HTMLInputElement;
let editing: { p: Portage; isNew: boolean } | null = null;

function openDetails(p: Portage, isNew: boolean) {
  editing = { p, isNew };
  map.closePopup();
  $('portage-title').textContent = isNew ? 'New path' : 'Edit path';
  field('name').value = p.name;
  field('kind').value = p.kind;
  field('description').value = p.description;
  const routeSel = form().elements.namedItem('routeId') as HTMLSelectElement;
  routeSel.innerHTML =
    '<option value="">None</option>' +
    [...state.routes]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`)
      .join('');
  routeSel.value = p.routeId ?? '';
  $('portage-length').textContent = fmtWalk(lengthKm(p.coords));
  $('portage-delete').hidden = isNew;
  syncKindHint();
  dialog().showModal();
  if (isNew) field('name').focus();
}

function syncKindHint() {
  $('portage-kind-hint').textContent = PATH_KINDS[field('kind').value as PathKind].hint;
}

export function initPortages() {
  $('new-portage').addEventListener('click', startNewPortage);
  field('kind').addEventListener('change', syncKindHint);

  form().addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editing) return;
    const { p } = editing;
    const kind = field('kind').value as PathKind;
    p.kind = kind;
    p.name = field('name').value.trim() || PATH_KINDS[kind].label;
    p.description = field('description').value.trim();
    p.routeId = (form().elements.namedItem('routeId') as HTMLSelectElement).value || undefined;
    await savePortage(p);
    editing = null;
    dialog().close();
  });
  $('portage-cancel').addEventListener('click', () => {
    // A brand-new line is kept rather than lost: save it with a default name.
    if (editing?.isNew) void savePortage({ ...editing.p, name: PATH_KINDS[editing.p.kind].label });
    editing = null;
    dialog().close();
  });
  $('portage-delete').addEventListener('click', async () => {
    const p = editing?.p;
    if (!p || !confirm(`Delete “${p.name}”?`)) return;
    await del('portages', p.id);
    state.portages = state.portages.filter((x) => x.id !== p.id);
    editing = null;
    dialog().close();
    renderPortages();
    document.dispatchEvent(new CustomEvent('portages-changed'));
  });

  $('portage-list').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]')?.dataset.id;
    const p = id && findPortage(id);
    const line = id && lines.get(id);
    if (!p || !line) return;
    map.fitBounds(line.getBounds(), { padding: [60, 60], maxZoom: 17 });
    L.popup({ maxWidth: 300 }).setLatLng(line.getCenter()).setContent(popupHtml(p)).openOn(map);
    closeSidebarOnMobile();
  });

  map.getContainer().addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-portage-action]');
    const p = btn?.dataset.id ? findPortage(btn.dataset.id) : undefined;
    if (!btn || !p) return;
    if (btn.dataset.portageAction === 'details') openDetails(p, false);
    else if (btn.dataset.portageAction === 'line') editLine(p);
  });
}

/** When a route is deleted, its paths stay but are no longer attached to it. */
export async function detachFromRoute(routeId: string) {
  for (const p of portagesOf(routeId)) {
    delete p.routeId;
    await put('portages', p);
  }
  renderPortages();
}
