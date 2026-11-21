import L from 'leaflet';
import { layersControl, map } from './map';
import { poiType } from './osm';
import { openNewPoint } from './points';
import { allOfflineAreas } from './state';
import { locateOnLine } from './geo';
import type { LatLng, OfflineArea, OsmFeature, OsmTile } from './types';
import { escapeHtml, getMode, prefs } from './ui';

const OVERLAY_NAME = 'Trails, parks &amp; campsites (OSM)';
const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
const LABEL_MIN_ZOOM = 11;
/** Data tiles are ~2 km wide; show only what lies within the saved corridor plus this margin. */
const CORRIDOR_MARGIN_KM = 0.25;
/** Parking this close to a saved route counts as river access, like parking inside a park. */
const NEAR_RIVER_KM = 0.3;

const renderer = L.canvas({ padding: 0.5 });
const parks = L.layerGroup();
const paths = L.layerGroup();
const labels = L.layerGroup();
/** POI marker groups keyed by the zoom at which they appear. */
const poiGroups = new Map<number, L.LayerGroup>();
export const osmOverlay = L.layerGroup([parks, paths]);
let lastTiles: OsmTile[] = [];

const PATH_STYLE: Record<string, L.PolylineOptions> = {
  path: { color: '#7b4b2a', weight: 2, dashArray: '4 4', opacity: 0.9 },
  track: { color: '#9c6b3c', weight: 2, dashArray: '10 5', opacity: 0.8 },
};

/** Show a popup only when not placing a point or drawing a route. */
function popupOnTap(layer: L.Layer, html: () => string) {
  layer.on('click', (e: L.LeafletMouseEvent) => {
    if (getMode() !== 'idle') return;
    L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(html()).openOn(map);
  });
}

function popupHtml(title: string, kind: string, extra = '') {
  return `<div class="popup"><strong>${escapeHtml(title)}</strong>
    <div class="popup-meta">${escapeHtml(kind)} · OpenStreetMap</div>${extra}</div>`;
}

// ---------- geometry helpers ----------
function ringArea(r: LatLng[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][1] + r[i][1]) * (r[j][0] - r[i][0]);
  return Math.abs(a / 2);
}

function centroid(r: LatLng[]): LatLng {
  let lat = 0;
  let lng = 0;
  for (const [a, b] of r) {
    lat += a;
    lng += b;
  }
  return [lat / r.length, lng / r.length];
}

function pointInRing([lat, lng]: LatLng, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

interface Box {
  s: number;
  w: number;
  n: number;
  e: number;
}
const inBox = (p: LatLng, b: Box) => p[0] >= b.s && p[0] <= b.n && p[1] >= b.w && p[1] <= b.e;
function bboxOf(pts: LatLng[], padKm = 0): Box {
  const lats = pts.map((p) => p[0]);
  const lngs = pts.map((p) => p[1]);
  const dLat = padKm / 110.574;
  const dLng = padKm / (111.32 * Math.cos(((lats[0] ?? 0) * Math.PI) / 180));
  return { s: Math.min(...lats) - dLat, n: Math.max(...lats) + dLat, w: Math.min(...lngs) - dLng, e: Math.max(...lngs) + dLng };
}

/** Saved corridors, for trimming features to what the user actually asked to save. */
function corridorTester(areas: OfflineArea[]) {
  const prepared = areas.filter((a) => a.osm).map((a) => ({ ...a, box: bboxOf(a.coords, a.bufferKm + CORRIDOR_MARGIN_KM) }));
  const within = (p: LatLng, extraKm: number | null) =>
    prepared.some((a) => {
      const limit = extraKm ?? a.bufferKm + CORRIDOR_MARGIN_KM;
      if (!inBox(p, a.box)) return false;
      const loc = locateOnLine(a.coords, p);
      return !!loc && loc.offKm <= limit;
    });
  return {
    /** Within the saved corridor (buffer + margin). */
    near: (p: LatLng) => within(p, null),
    /** Close to the river line itself. */
    nearRiver: (p: LatLng) => within(p, NEAR_RIVER_KM),
    /** A route vertex lies inside this ring (the corridor runs through the park). */
    crosses: (ring: LatLng[]) => prepared.some((a) => a.coords.some((c) => pointInRing(c, ring))),
  };
}

/**
 * Keep only the stretches of each line inside the corridor, plus one vertex past
 * each edge so lines run to the boundary instead of stopping short.
 */
function trimToCorridor(parts: LatLng[][], near: (p: LatLng) => boolean): LatLng[][] {
  const out: LatLng[][] = [];
  for (const part of parts) {
    const inside = part.map(near);
    let run: LatLng[] = [];
    for (let i = 0; i < part.length; i++) {
      if (inside[i] || inside[i - 1] || inside[i + 1]) run.push(part[i]);
      else if (run.length) {
        if (run.length > 1) out.push(run);
        run = [];
      }
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

const parkKind = (cls: string) =>
  ({ national_park: 'National park / recreation area', nature_reserve: 'Nature reserve', protected_area: 'Protected area' })[
    cls
  ] ?? 'Park';

// ---------- labels ----------
interface ParkLabel {
  name: string;
  at: LatLng;
  area: number;
}
let parkLabels: ParkLabel[] = [];

/** Place park labels largest-first, skipping any that would overlap one already placed. */
function placeLabels() {
  labels.clearLayers();
  const z = map.getZoom();
  if (z < LABEL_MIN_ZOOM) return;
  const placed: L.Bounds[] = [];
  for (const l of parkLabels) {
    const p = map.project(l.at, z);
    const halfW = l.name.length * 3.4 + 6;
    const box = L.bounds([p.x - halfW, p.y - 10], [p.x + halfW, p.y + 10]);
    if (placed.some((b) => b.intersects(box))) continue;
    placed.push(box);
    const icon = L.divIcon({ className: 'osm-label', html: `<span>${escapeHtml(l.name)}</span>`, iconSize: [0, 0] });
    labels.addLayer(L.marker(l.at, { icon, interactive: false, keyboard: false }).setZIndexOffset(-1000));
  }
}

// ---------- rendering ----------
interface ParkPoly {
  f: OsmFeature;
  box: Box;
  area: number;
  name?: string;
}

export function renderOsm(tiles: OsmTile[]) {
  lastTiles = tiles;
  for (const g of [parks, paths, labels, ...poiGroups.values()]) g.clearLayers();
  const corridor = corridorTester(allOfflineAreas());
  const features = tiles.flatMap((t) => t.features);

  // Parks near (or crossed by) the corridor, with names from the park itself or a name point inside it.
  const parkPolys: ParkPoly[] = features
    .filter((f) => f.kind === 'park')
    .filter((f) => f.geom[0].some(corridor.near) || corridor.crosses(f.geom[0]))
    .map((f) => ({ f, box: bboxOf(f.geom[0]), area: ringArea(f.geom[0]), name: f.name }));
  const parkAt = (p: LatLng) => parkPolys.find((pp) => inBox(p, pp.box) && pointInRing(p, pp.f.geom[0]));

  const nameLabels = new Map<string, ParkLabel>();
  for (const f of features) {
    if (f.kind !== 'label' || !f.name) continue;
    const p = f.geom[0][0];
    const park = parkAt(p);
    if (!park && !corridor.near(p)) continue;
    if (park && !park.name) park.name = f.name;
    if (!nameLabels.has(f.name)) nameLabels.set(f.name, { name: f.name, at: p, area: park?.area ?? 0 });
  }

  for (const pp of parkPolys) {
    const poly = L.polygon(pp.f.geom, { renderer, stroke: false, fillColor: '#2e7d32', fillOpacity: 0.13 });
    popupOnTap(poly, () => popupHtml(pp.name ?? 'Park', parkKind(pp.f.cls)));
    parks.addLayer(poly);
    // Named park outlines label at their largest piece's centre.
    if (pp.f.name && pp.area > (nameLabels.get(pp.f.name)?.area ?? -1)) {
      nameLabels.set(pp.f.name, { name: pp.f.name, at: centroid(pp.f.geom[0]), area: pp.area });
    }
  }
  parkLabels = [...nameLabels.values()].sort((a, b) => b.area - a.area);

  const seenPoi = new Set<string>();
  for (const f of features) {
    if (f.kind === 'path' || f.kind === 'trail') {
      const geom = trimToCorridor(f.geom, corridor.near);
      if (!geom.length) continue;
      if (f.kind === 'path') {
        paths.addLayer(L.polyline(geom, { renderer, interactive: false, ...PATH_STYLE[f.cls] }));
      } else {
        // Named segments: a wider invisible hit area so they're tappable on a phone.
        const hit = L.polyline(geom, { renderer, weight: 14, opacity: 0 });
        popupOnTap(hit, () => popupHtml(f.name!, f.cls === 'track' ? 'Track' : 'Trail'));
        paths.addLayer(hit);
      }
    } else if (f.kind === 'poi') {
      const type = poiType(f.cls, f.sub);
      const p = f.geom[0][0];
      const key = `${f.cls}|${f.name ?? ''}|${p[0].toFixed(4)},${p[1].toFixed(4)}`;
      if (!type || seenPoi.has(key) || !corridor.near(p)) continue;
      seenPoi.add(key);
      const minZoom =
        type.minZoomElsewhere && !parkAt(p) && !corridor.nearRiver(p) ? type.minZoomElsewhere : type.minZoom;
      const marker = L.marker(p, {
        icon: L.divIcon({ className: '', html: `<div class="osm-poi">${type.icon}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        keyboard: false,
      });
      popupOnTap(marker, () =>
        popupHtml(
          f.name ?? type.label,
          type.label,
          `<button class="btn small" data-osm-add data-lat="${p[0]}" data-lng="${p[1]}"
            data-name="${escapeHtml(f.name ?? type.label)}" data-category="${type.category}">Add as my point</button>`,
        ),
      );
      let group = poiGroups.get(minZoom);
      if (!group) poiGroups.set(minZoom, (group = L.layerGroup()));
      group.addLayer(marker);
    }
  }
  syncZoomLayers();
}

/** Re-render with the same data, e.g. after the saved corridors changed. */
export const rerenderOsm = () => renderOsm(lastTiles);

/** Labels and POIs appear only from certain zoom levels. */
function syncZoomLayers() {
  const z = map.getZoom();
  const toggle = (layer: L.Layer, on: boolean) => {
    if (on) osmOverlay.addLayer(layer);
    else osmOverlay.removeLayer(layer);
  };
  placeLabels();
  toggle(labels, z >= LABEL_MIN_ZOOM);
  for (const [minZoom, group] of poiGroups) toggle(group, z >= minZoom);
}

export function initOsmLayer() {
  layersControl.addOverlay(osmOverlay, OVERLAY_NAME);
  if (prefs.get('osmOverlay') !== 'off') osmOverlay.addTo(map);
  if (map.hasLayer(osmOverlay)) map.attributionControl.addAttribution(ATTRIBUTION);
  map.on('overlayadd', (e: L.LayersControlEvent) => {
    if (e.layer !== osmOverlay) return;
    prefs.set('osmOverlay', 'on');
    map.attributionControl.addAttribution(ATTRIBUTION);
  });
  map.on('overlayremove', (e: L.LayersControlEvent) => {
    if (e.layer !== osmOverlay) return;
    prefs.set('osmOverlay', 'off');
    map.attributionControl.removeAttribution(ATTRIBUTION);
  });
  map.on('zoomend', syncZoomLayers);

  map.getContainer().addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-osm-add]');
    if (!btn) return;
    const { lat, lng, name, category } = btn.dataset;
    openNewPoint({
      lat: Number(lat),
      lng: Number(lng),
      name: name ?? '',
      category: category as Parameters<typeof openNewPoint>[0]['category'],
      description: 'From OpenStreetMap',
    });
  });
}
