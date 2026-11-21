import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { map } from './map';
import { state } from './state';
import { getAll } from './store';
import { toGeoJSON } from './geojson';
import { importFile, initShare } from './share';
import { initPoints, renderPoints } from './points';
import { initRoutes, refreshStorageInfo, renderRoutes } from './routes';
import { initOsmLayer, renderOsm } from './osmLayer';
import { loadAllOsm } from './osm';
import { finishInterruptedTracks, initTracks, renderTracks } from './tracks';
import { initPhotos, renderPhotos } from './photos';
import { saveFile } from './platform';
import { $, prefs } from './ui';

initOsmLayer();
initPoints();
initRoutes();
initTracks();
initPhotos();
initShare();

// ---------- sidebar ----------
$('toggle-sidebar').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-open');
  setTimeout(() => map.invalidateSize(), 250);
});

function showTab(tab: string) {
  for (const btn of document.querySelectorAll<HTMLElement>('[data-tab]')) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
    $(`tab-${btn.dataset.tab}`).hidden = !on;
  }
  prefs.set('tab', tab);
}
document.querySelector('.tabs')!.addEventListener('click', (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
  if (tab) showTab(tab);
});
const savedTab = prefs.get('tab');
showTab(savedTab === 'routes' || savedTab === 'tracks' ? savedTab : 'points');

// ---------- import / export ----------
$('export').addEventListener('click', () => {
  const data = toGeoJSON(state.points, state.routes, state.tracks);
  const name = `river-guide-${new Date().toISOString().slice(0, 10)}.geojson`;
  void saveFile(name, JSON.stringify(data, null, 2), 'application/geo+json');
});

$<HTMLInputElement>('import').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    await importFile(file);
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

// ---------- offline indicator ----------
const syncOnline = () => document.body.classList.toggle('offline', !navigator.onLine);
window.addEventListener('online', syncOnline);
window.addEventListener('offline', syncOnline);
syncOnline();

// ---------- boot ----------
const [points, routes, tracks, photos, osmTiles] = await Promise.all([
  getAll('points'),
  getAll('routes'),
  getAll('tracks'),
  getAll('photos'),
  loadAllOsm(),
]);
Object.assign(state, { points, routes, tracks, photos });
await finishInterruptedTracks();
renderOsm(osmTiles);
renderRoutes();
renderTracks();
renderPhotos();
renderPoints();
void refreshStorageInfo();
