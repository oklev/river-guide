import L from 'leaflet';
import { OfflineTileLayer, USGS_MAX_ZOOM, USGS_TOPO_URL } from './tiles';
import { prefs } from './ui';

function savedView(): { center: L.LatLngTuple; zoom: number } {
  try {
    const v = JSON.parse(prefs.get('view') ?? '');
    if (Number.isFinite(v.lat) && Number.isFinite(v.lng) && Number.isFinite(v.zoom)) {
      return { center: [v.lat, v.lng], zoom: v.zoom };
    }
  } catch {
    /* fall through */
  }
  return { center: [32.9, -83.4], zoom: 7 }; // Georgia
}

const view = savedView();
export const map = L.map('map', { zoomControl: false }).setView(view.center, view.zoom);
L.control.zoom({ position: 'bottomright' }).addTo(map);
// Reopen where you left off, which matters most offline (your saved area, not the whole state).
map.on('moveend', () => {
  const c = map.getCenter();
  prefs.set('view', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
});

const baseLayers: Record<string, L.TileLayer> = {
  'USGS Topo (works offline)': new OfflineTileLayer(USGS_TOPO_URL, {
    maxNativeZoom: USGS_MAX_ZOOM,
    maxZoom: 19,
    attribution: 'USGS The National Map',
  }),
  'OpenStreetMap (online only)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }),
};

const saved = prefs.get('baseLayer');
(baseLayers[saved ?? ''] ?? Object.values(baseLayers)[0]).addTo(map);
L.control.layers(baseLayers, undefined, { position: 'topright' }).addTo(map);
map.on('baselayerchange', (e: L.LayersControlEvent) => prefs.set('baseLayer', e.name));
