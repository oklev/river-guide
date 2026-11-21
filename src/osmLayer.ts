import L from 'leaflet';
import { layersControl, map } from './map';
import { poiType } from './osm';
import { openNewPoint } from './points';
import type { LatLng, OsmFeature, OsmTile } from './types';
import { escapeHtml, getMode, prefs } from './ui';

const OVERLAY_NAME = 'Trails, parks &amp; campsites (OSM)';
const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
const LABEL_MIN_ZOOM = 11;

const renderer = L.canvas({ padding: 0.5 });
const parks = L.layerGroup();
const paths = L.layerGroup();
const labels = L.layerGroup();
/** POI marker groups keyed by the zoom at which they appear. */
const poiGroups = new Map<number, L.LayerGroup>();
export const osmOverlay = L.layerGroup([parks, paths]);

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

/** Park outer rings with bounding boxes, for quick "is this inside a park?" checks. */
type ParkIndex = { ring: LatLng[]; s: number; w: number; n: number; e: number }[];
function inAnyPark(p: LatLng, index: ParkIndex): boolean {
  return index.some((r) => p[0] >= r.s && p[0] <= r.n && p[1] >= r.w && p[1] <= r.e && pointInRing(p, r.ring));
}

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

const parkKind = (cls: string) =>
  ({ national_park: 'National park / recreation area', nature_reserve: 'Nature reserve', protected_area: 'Protected area' })[
    cls
  ] ?? 'Park';

export function renderOsm(tiles: OsmTile[]) {
  for (const g of [parks, paths, labels, ...poiGroups.values()]) g.clearLayers();

  const seenPoi = new Set<string>();
  /** Largest piece of each named park, for placing one label per park. */
  const parkLabel = new Map<string, { area: number; at: LatLng }>();

  const features: OsmFeature[] = tiles.flatMap((t) => t.features);
  const parkIndex: ParkIndex = features
    .filter((f) => f.kind === 'park')
    .map((f) => {
      const lats = f.geom[0].map((p) => p[0]);
      const lngs = f.geom[0].map((p) => p[1]);
      return { ring: f.geom[0], s: Math.min(...lats), n: Math.max(...lats), w: Math.min(...lngs), e: Math.max(...lngs) };
    });
  for (const f of features) {
    if (f.kind === 'park') {
      const poly = L.polygon(f.geom, { renderer, stroke: false, fillColor: '#2e7d32', fillOpacity: 0.13 });
      popupOnTap(poly, () => popupHtml(f.name ?? 'Unnamed park', parkKind(f.cls)));
      parks.addLayer(poly);
      if (f.name) {
        const area = ringArea(f.geom[0]);
        if (area > (parkLabel.get(f.name)?.area ?? 0)) parkLabel.set(f.name, { area, at: centroid(f.geom[0]) });
      }
    } else if (f.kind === 'path') {
      paths.addLayer(L.polyline(f.geom, { renderer, interactive: false, ...PATH_STYLE[f.cls] }));
    } else if (f.kind === 'trail') {
      // Named segments: a wider invisible hit area so they're tappable on a phone.
      const hit = L.polyline(f.geom, { renderer, weight: 14, opacity: 0 });
      popupOnTap(hit, () => popupHtml(f.name!, f.cls === 'track' ? 'Track' : 'Trail'));
      paths.addLayer(hit);
    } else if (f.kind === 'poi') {
      const type = poiType(f.cls, f.sub);
      const [lat, lng] = f.geom[0][0];
      const key = `${f.cls}|${f.name ?? ''}|${lat.toFixed(4)},${lng.toFixed(4)}`;
      if (!type || seenPoi.has(key)) continue;
      if (type.onlyInParks && !inAnyPark([lat, lng], parkIndex)) continue;
      seenPoi.add(key);
      const marker = L.marker([lat, lng], {
        icon: L.divIcon({ className: '', html: `<div class="osm-poi">${type.icon}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        keyboard: false,
      });
      popupOnTap(marker, () =>
        popupHtml(
          f.name ?? type.label,
          type.label,
          `<button class="btn small" data-osm-add data-lat="${lat}" data-lng="${lng}"
            data-name="${escapeHtml(f.name ?? type.label)}" data-category="${type.category}">Add as my point</button>`,
        ),
      );
      let group = poiGroups.get(type.minZoom);
      if (!group) poiGroups.set(type.minZoom, (group = L.layerGroup()));
      group.addLayer(marker);
    }
  }

  parkLabels = [...parkLabel].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.area - a.area);
  syncZoomLayers();
}

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
