import type { LatLng } from './types';

/** Everything a trip report page shows. Embedded in the page as JSON. */
export interface ReportItem {
  kind: 'start' | 'finish' | 'photo' | 'point';
  title: string;
  text: string;
  time?: number;
  mile?: number;
  at?: LatLng;
  /** Index into ReportData.photos. */
  photo?: number;
  category?: string;
  icon?: string;
  color?: string;
}

export interface ReportData {
  title: string;
  subtitle: string;
  date: number;
  stats: {
    distanceMi?: number;
    totalMs?: number;
    movingMs?: number;
    avgMph?: number;
    photos: number;
    points: number;
  };
  route: LatLng[];
  routeColor: string;
  track: LatLng[];
  items: ReportItem[];
  photos: { src: string; panorama: boolean }[];
  tiles: { url: string; maxNativeZoom: number; attribution: string };
  generated: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** JSON that is safe inside <script>: no "</script>" or "<!--" can appear. */
const scriptJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));

export async function reportHtml(data: ReportData): Promise<string> {
  // Leaflet is embedded so the report doesn't depend on a CDN (only tiles need internet).
  const [{ default: leafletJs }, { default: leafletCss }] = await Promise.all([
    import('leaflet/dist/leaflet.js?raw'),
    import('leaflet/dist/leaflet.css?raw'),
  ]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(data.title)} · Trip report</title>
<style>${leafletCss}</style>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <div id="date" class="muted"></div>
  <p id="subtitle"></p>
  <div id="stats" class="stats"></div>
</header>
<div class="layout">
  <div id="map"></div>
  <ol id="timeline" class="timeline"></ol>
</div>
<footer class="muted">Made with River Guide · <span id="generated"></span></footer>
<div id="viewer" class="viewer" hidden><div class="viewer-scroll"><img id="viewer-img" alt="" /></div><div id="viewer-caption" class="viewer-caption"></div><button id="viewer-close" aria-label="Close">✕</button></div>
<script>${leafletJs.replace(/<\/script/gi, '<\\/script')}</script>
<script id="data" type="application/json">${scriptJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const CSS = `
:root { --bg: #fff; --fg: #1d2a30; --muted: #61727a; --border: #dbe3e6; --accent: #0f4c5c; --card: #f6f9fa; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #172227; --fg: #e4ecef; --muted: #93a5ad; --border: #2c3b41; --accent: #3fa7b8; --card: #1e2c32; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
header { padding: 20px 16px 8px; max-width: 1200px; margin: 0 auto; }
h1 { margin: 0; color: var(--accent); font-size: 1.6rem; }
.muted { color: var(--muted); }
#subtitle:empty { display: none; }
.stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 6px 12px; }
.stat b { display: block; font-size: 1.15rem; }
.stat span { font-size: 12px; color: var(--muted); }
.layout { max-width: 1200px; margin: 0 auto; padding: 8px 16px 24px; display: grid; gap: 16px; }
#map { height: 45vh; min-height: 260px; border-radius: 12px; border: 1px solid var(--border); position: sticky; top: 0; z-index: 1; }
@media (min-width: 900px) {
  .layout { grid-template-columns: 1.3fr 1fr; align-items: start; }
  #map { height: calc(100vh - 32px); top: 16px; }
}
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { position: relative; padding: 0 0 18px 28px; cursor: pointer; }
.timeline li::before { content: ''; position: absolute; left: 9px; top: 18px; bottom: -2px; width: 2px; background: var(--border); }
.timeline li:last-child::before { display: none; }
.dot { position: absolute; left: 0; top: 2px; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; color: #fff; background: var(--accent); }
.when { font-size: 13px; color: var(--muted); }
.timeline h3 { margin: 0; font-size: 1rem; }
.timeline p { margin: 2px 0 0; }
.timeline img { display: block; width: 100%; max-height: 360px; object-fit: cover; border-radius: 10px; margin-top: 6px; background: var(--card); }
.timeline img.pano { max-height: 200px; }
.timeline li.active h3 { color: var(--accent); }
.badge { display: inline-block; font-size: 12px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; margin-left: 4px; }
footer { text-align: center; font-size: 13px; padding: 8px 16px 32px; }
.thumb-pin { width: 38px; height: 38px; border-radius: 8px; overflow: hidden; border: 2px solid #fff; box-shadow: 0 1px 4px rgb(0 0 0 / 0.5); }
.thumb-pin img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pt-pin { width: 24px; height: 24px; border-radius: 50%; border: 2px solid #fff; display: grid; place-items: center; color: #fff; font-size: 12px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.5); }
.viewer { position: fixed; inset: 0; background: #000; z-index: 2000; display: flex; flex-direction: column; }
.viewer[hidden] { display: none; }
.viewer-scroll { flex: 1; min-height: 0; overflow: auto; display: flex; align-items: center; justify-content: center; }
.viewer-scroll img { max-width: 100%; max-height: 100%; object-fit: contain; }
.viewer.pano .viewer-scroll { justify-content: flex-start; }
.viewer.pano .viewer-scroll img { max-width: none; height: 100%; width: auto; }
.viewer-caption { color: #ddd; padding: 10px 16px; font-size: 14px; }
#viewer-close { position: absolute; top: 12px; right: 12px; width: 40px; height: 40px; border-radius: 50%; border: 0; background: rgb(255 255 255 / 0.85); font-size: 18px; cursor: pointer; }
`;

// Runs inside the report page (plain JS, no imports).
const SCRIPT = `
(function () {
  var d = JSON.parse(document.getElementById('data').textContent);
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmtDate = function (t) { return new Date(t).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); };
  var fmtTime = function (t) { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  var fmtDur = function (ms) { var m = Math.round(ms / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
  $('title').textContent = d.title;
  $('date').textContent = fmtDate(d.date);
  $('subtitle').textContent = d.subtitle;
  $('generated').textContent = 'report made ' + fmtDate(d.generated);
  var s = d.stats, stats = [];
  if (s.distanceMi != null) stats.push([s.distanceMi.toFixed(1) + ' mi', 'distance']);
  if (s.totalMs) stats.push([fmtDur(s.totalMs), 'total time']);
  if (s.movingMs) stats.push([fmtDur(s.movingMs), 'moving']);
  if (s.avgMph) stats.push([s.avgMph.toFixed(1) + ' mph', 'average moving speed']);
  if (s.photos) stats.push([String(s.photos), s.photos === 1 ? 'photo' : 'photos']);
  stats.forEach(function (x) {
    var el = document.createElement('div'); el.className = 'stat';
    var b = document.createElement('b'); b.textContent = x[0];
    var sp = document.createElement('span'); sp.textContent = x[1];
    el.append(b, sp); $('stats').append(el);
  });

  var map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer(d.tiles.url, { maxNativeZoom: d.tiles.maxNativeZoom, maxZoom: 18, attribution: d.tiles.attribution }).addTo(map);
  var bounds = L.latLngBounds([]);
  if (d.route.length) { var r = L.polyline(d.route, { color: d.routeColor, weight: 4, opacity: 0.45, dashArray: '8 8' }).addTo(map); bounds.extend(r.getBounds()); }
  if (d.track.length) { var t = L.polyline(d.track, { color: '#e65100', weight: 4, opacity: 0.9 }).addTo(map); bounds.extend(t.getBounds()); }

  var markers = [];
  d.items.forEach(function (it, i) {
    if (!it.at) return;
    var html;
    if (it.kind === 'photo') html = '<div class="thumb-pin"><img src="' + d.photos[it.photo].src + '" alt=""></div>';
    else if (it.kind === 'point') html = '<div class="pt-pin" style="background:' + (it.color || '#0f4c5c') + '">' + esc(it.icon || '') + '</div>';
    else html = '<div class="pt-pin" style="background:' + (it.kind === 'start' ? '#2e7d32' : '#c62828') + '"></div>';
    var size = it.kind === 'photo' ? 42 : 24;
    var m = L.marker(it.at, { icon: L.divIcon({ className: '', html: html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }) }).addTo(map);
    m.on('click', function () { select(i, true); });
    markers[i] = m;
    bounds.extend(it.at);
  });
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] }); else map.setView([35, -85], 6);

  var lis = [];
  d.items.forEach(function (it, i) {
    var li = document.createElement('li');
    var dot = document.createElement('span'); dot.className = 'dot';
    dot.style.background = it.kind === 'start' ? '#2e7d32' : it.kind === 'finish' ? '#c62828' : it.kind === 'photo' ? '#0f4c5c' : (it.color || '#0f4c5c');
    dot.textContent = it.kind === 'photo' ? '◉' : it.kind === 'point' ? (it.icon || '•') : '';
    var when = document.createElement('div'); when.className = 'when';
    when.textContent = [it.time ? fmtTime(it.time) : '', it.mile != null ? 'mile ' + it.mile.toFixed(1) : ''].filter(Boolean).join(' · ');
    var h = document.createElement('h3'); h.textContent = it.title;
    if (it.category) { var bd = document.createElement('span'); bd.className = 'badge'; bd.textContent = it.category; h.append(bd); }
    li.append(dot, when, h);
    if (it.text) { var p = document.createElement('p'); p.textContent = it.text; li.append(p); }
    if (it.kind === 'photo') {
      var img = document.createElement('img'); img.src = d.photos[it.photo].src; img.alt = it.title; img.loading = 'lazy';
      if (d.photos[it.photo].panorama) img.className = 'pano';
      img.addEventListener('click', function (e) { e.stopPropagation(); openViewer(it); });
      li.append(img);
    }
    li.addEventListener('click', function () { select(i, false); });
    $('timeline').append(li); lis[i] = li;
  });

  function select(i, fromMap) {
    lis.forEach(function (li, j) { if (li) li.classList.toggle('active', j === i); });
    var it = d.items[i];
    if (it.at) map.flyTo(it.at, Math.max(map.getZoom(), 15), { duration: 0.6 });
    if (fromMap && lis[i]) lis[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function openViewer(it) {
    var ph = d.photos[it.photo];
    $('viewer').classList.toggle('pano', ph.panorama);
    $('viewer-img').src = ph.src;
    $('viewer-caption').textContent = [it.title, it.time ? fmtTime(it.time) : '', it.text].filter(Boolean).join(' · ') + (ph.panorama ? ' · swipe to look around' : '');
    $('viewer').hidden = false;
    var sc = $('viewer').querySelector('.viewer-scroll');
    $('viewer-img').onload = function () { sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2; };
  }
  $('viewer-close').addEventListener('click', function () { $('viewer').hidden = true; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('viewer').hidden = true; });
})();
`;
